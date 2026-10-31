"""Play time figures, computed from the sessions in play_sessions' store.

Everything the Play time page and the game page show comes from here, from
one list of sessions (this device's plus those pulled from RomM), so every
figure agrees with every other. Sections follow Argosy's Play Time screen
(ui/screens/settings/sections/PlayTime*.kt): activity summary and calendar,
the hour-of-week curve, platform and device shares, games, quick facts and
the RomM status.

Time is bucketed in local time. A session's played time is spread evenly
over its wall-clock span, so one crossing midnight or an hour boundary lands
in both.
"""

import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

HOUR = 3600


def _spread(start, end, active_ms, bucket):
    """Split active_ms over the local-time buckets [start, end) crosses.
    bucket(dt) names the bucket a local datetime falls in."""
    span = max(1, end - start)
    t = start
    out = defaultdict(float)
    while t < end:
        dt = datetime.fromtimestamp(t)
        nxt = int((dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)).timestamp())
        seg_end = min(end, nxt)
        out[bucket(dt)] += active_ms * (seg_end - t) / span
        t = seg_end
    if start >= end:
        out[bucket(datetime.fromtimestamp(start))] += active_ms
    return out


def _streaks(days, today):
    """(current, longest, longest_first_day, longest_last_day) over a set of dates."""
    if not days:
        return 0, 0, None, None
    ordered = sorted(days)
    longest, first, last = 1, ordered[0], ordered[0]
    run, run_first = 1, ordered[0]
    for prev, cur in zip(ordered, ordered[1:]):
        if (cur - prev).days == 1:
            run += 1
        else:
            run, run_first = 1, cur
        if run > longest:
            longest, first, last = run, run_first, cur
    current = 0
    d = today if today in days else today - timedelta(days=1)
    while d in days:
        current += 1
        d -= timedelta(days=1)
    return current, longest, first, last


def compute(sessions, games, this_device, devices, meta=None, now=None):
    """The Play time page, as plain data.

    sessions: store rows. games: {rom_id: {'name', 'platform_name',
    'platform_slug'}} for naming. this_device: this device's id. devices:
    {device_id: {'name', 'platform'}} from the last pull.
    """
    now = now or time.time()
    meta = meta or {}
    today = datetime.fromtimestamp(now).date()
    linked = [s for s in sessions if s.get('rom_id') is not None]

    def device_name(d):
        if d == this_device:
            return 'This device'
        return (devices.get(d) or {}).get('name') or 'Another device'

    total = sum(s['active_ms'] for s in linked)
    per_day = defaultdict(float)
    per_day_count = defaultdict(int)
    wave = [0.0] * 168
    by_platform = defaultdict(lambda: {'ms': 0, 'games': set()})
    by_device = defaultdict(float)
    by_game = defaultdict(lambda: {'ms': 0, 'sessions': 0, 'last': 0, 'longest': 0})
    for s in linked:
        start, end, ms = int(s['start']), int(s['end']), s['active_ms']
        # A session counts on every day it touches, so a day with time on
        # it (one crossing midnight) never shows none played.
        for day, v in _spread(start, end, ms, lambda dt: dt.date()).items():
            per_day[day] += v
            per_day_count[day] += 1
        for h, v in _spread(start, end, ms, lambda dt: dt.weekday() * 24 + dt.hour).items():
            wave[h] += v
        g = games.get(s['rom_id']) or {}
        plat = g.get('platform_name') or 'Unknown platform'
        by_platform[plat]['ms'] += ms
        by_platform[plat]['games'].add(s['rom_id'])
        by_platform[plat]['slug'] = g.get('platform_slug') or ''
        by_device[s.get('device_id')] += ms
        bg = by_game[s['rom_id']]
        bg['ms'] += ms
        bg['sessions'] += 1
        bg['last'] = max(bg['last'], end)
        bg['longest'] = max(bg['longest'], ms)

    played_days = {d for d, v in per_day.items() if v > 0}
    first_day = min(played_days) if played_days else today
    window = (today - first_day).days + 1
    current, longest, l_first, l_last = _streaks(played_days, today)
    busiest_hour = max(range(168), key=lambda i: wave[i]) if total else None
    busiest_day = max(per_day.items(), key=lambda kv: kv[1]) if per_day else None
    top_device = max(by_device.items(), key=lambda kv: kv[1])[0] if by_device else None
    durations = [s['active_ms'] for s in linked]

    def share(items):
        return [dict(x, share=(x['ms'] / total if total else 0)) for x in items]

    platforms = share(sorted(
        ({'name': k, 'slug': v['slug'], 'ms': int(v['ms']), 'games': len(v['games'])}
         for k, v in by_platform.items()), key=lambda x: -x['ms']))
    device_rows = share(sorted(
        ({'id': k, 'name': device_name(k), 'this': k == this_device, 'ms': int(v)}
         for k, v in by_device.items()), key=lambda x: -x['ms']))
    for i, d in enumerate(device_rows):
        d['rank'] = i
    game_rows = sorted(
        ({'rom_id': k, 'name': (games.get(k) or {}).get('name') or '',
          'platform': (games.get(k) or {}).get('platform_name') or '',
          'ms': int(v['ms']), 'sessions': v['sessions'], 'last': v['last'],
          'longest': v['longest']} for k, v in by_game.items()),
        key=lambda x: -x['ms'])

    # Last month, for the recap card.
    first_this = today.replace(day=1)
    last_month_end = first_this - timedelta(days=1)
    lm_first = last_month_end.replace(day=1)
    lm = [s for s in linked if lm_first <= datetime.fromtimestamp(s['start']).date() <= last_month_end]
    lm_games = defaultdict(int)
    for s in lm:
        lm_games[s['rom_id']] += s['active_ms']

    local = [s for s in sessions if s.get('origin') == 'local']
    return {
        'has_data': bool(linked),
        'summary': {
            'total_ms': int(total),
            'window_days': window,
            'platforms': len(by_platform),
            'busiest_hour': None if busiest_hour is None else
                {'weekday': busiest_hour // 24, 'hour': busiest_hour % 24},
            'most_played_on': device_name(top_device) if top_device else None,
            'current_streak': current,
            'longest_streak': longest,
            'longest_streak_range': [l_first.isoformat(), l_last.isoformat()] if l_first else None,
        },
        'calendar': {d.isoformat(): [int(per_day[d]), per_day_count.get(d, 0)] for d in per_day},
        'wave': [int(v) for v in wave],
        'platforms': platforms,
        'devices': device_rows,
        'games': game_rows,
        'facts': {
            'average_ms': int(sum(durations) / len(durations)) if durations else 0,
            'longest_ms': max(durations) if durations else 0,
            'sessions': len(linked),
            'days_played': len(played_days),
            'days_window': window,
            'per_day_ms': int(total / len(played_days)) if played_days else 0,
            'busiest_day': {'date': busiest_day[0].isoformat(), 'ms': int(busiest_day[1])}
                if busiest_day else None,
        },
        'last_month': {
            'month': lm_first.isoformat(),
            'total_ms': int(sum(s['active_ms'] for s in lm)),
            'sessions': len(lm),
            'top': [k for k, _ in sorted(lm_games.items(), key=lambda kv: -kv[1])[:4]],
        },
        'romm': {
            'on_server': sum(1 for s in sessions if s.get('sent')),
            'pending': sum(1 for s in local if not s.get('sent')),
            'unlinked': sum(1 for s in sessions if s.get('rom_id') is None),
            'from_other_devices': sum(1 for s in sessions if s.get('device_id') != this_device),
            'last_upload': meta.get('last_upload'),
            'last_refresh': meta.get('last_refresh'),
        },
    }


def for_game(sessions, rom_id, this_device, devices):
    """One game's play time, for its page. None when it was never played."""
    rows = [s for s in sessions if s.get('rom_id') == rom_id]
    if not rows:
        return None
    # A device keeps one colour everywhere: its rank over all play, the same
    # rank the Play time page colours it by.
    overall = defaultdict(int)
    for s in sessions:
        if s.get('rom_id') is not None:
            overall[s.get('device_id')] += s['active_ms']
    rank = {d: i for i, (d, _) in enumerate(sorted(overall.items(), key=lambda kv: -kv[1]))}
    total = sum(s['active_ms'] for s in rows)
    by_device = defaultdict(int)
    for s in rows:
        by_device[s.get('device_id')] += s['active_ms']

    def device_name(d):
        if d == this_device:
            return 'This device'
        return (devices.get(d) or {}).get('name') or 'Another device'

    return {
        'total_ms': int(total),
        'sessions': len(rows),
        'average_ms': int(total / len(rows)),
        'longest_ms': max(s['active_ms'] for s in rows),
        'last': max(s['end'] for s in rows),
        'devices': sorted(({'id': d, 'name': device_name(d), 'this': d == this_device,
                            'ms': ms, 'share': ms / total if total else 0, 'rank': rank.get(d, 99)}
                           for d, ms in by_device.items()), key=lambda x: -x['ms']),
    }


def top_games(sessions, limit=20):
    """[(rom_id, ms)] by total time, for the Most played row."""
    per = defaultdict(int)
    for s in sessions:
        if s.get('rom_id') is not None:
            per[s['rom_id']] += s['active_ms']
    return sorted(per.items(), key=lambda kv: -kv[1])[:limit]


def _parse_utc(s):
    """RomM's RetroAchievements dates ('2025-07-06 22:51:54' or ISO with an
    offset) as epoch seconds; naive ones are UTC. None when unreadable."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _month_bounds(month):
    """[start, end) epoch seconds of a 'YYYY-MM' month in local time."""
    y, m = (int(x) for x in month.split('-'))
    first = datetime(y, m, 1)
    nxt = datetime(y + (m == 12), m % 12 + 1, 1)
    return first.timestamp(), nxt.timestamp(), first.date(), (nxt - timedelta(days=1)).day


def _shift_month(month, by):
    y, m = (int(x) for x in month.split('-'))
    i = y * 12 + (m - 1) + by
    return f'{i // 12:04d}-{i % 12 + 1:02d}'


TOP_RECAP_GAMES = 5
FAVORITES_TOP = 3


def month_recap(sessions, games, month, progression=None, ra_games=None):
    """One month's recap, after Argosy's (domain/usecase/recap): the month's
    play time, its most played game, sessions, days played, longest session
    and busiest day, the top games with the ones new to the top marked, and
    the RetroAchievements unlocked and games mastered or completed in it.

    Sessions belong to the month their start falls in (local time).
    progression: RomM's /api/users/me ra_progression results. ra_games:
    {ra_id: {'rom_id', 'name', 'achievements': {badge_id: {...}}}} naming
    the games behind the unlocks; unlocks of games it lacks still count.
    """
    progression = progression or []
    ra_games = ra_games or {}
    start, end, first_day, ndays = _month_bounds(month)
    linked = [s for s in sessions if s.get('rom_id') is not None]

    def totals(rows):
        per = defaultdict(lambda: {'ms': 0, 'sessions': 0})
        for s in rows:
            per[s['rom_id']]['ms'] += s['active_ms']
            per[s['rom_id']]['sessions'] += 1
        return sorted(per.items(), key=lambda kv: (-kv[1]['ms'], kv[0]))

    in_month = [s for s in linked if start <= s['start'] < end]
    p_start = _month_bounds(_shift_month(month, -1))[0]
    prev_top = {k for k, _ in totals([s for s in linked if p_start <= s['start'] < start])[:FAVORITES_TOP]}
    first_played = {}
    for s in linked:
        first_played[s['rom_id']] = min(first_played.get(s['rom_id'], s['start']), s['start'])

    days = [0] * ndays
    for s in in_month:
        for day, v in _spread(int(s['start']), int(s['end']), s['active_ms'], lambda dt: dt.date()).items():
            i = (day - first_day).days
            if 0 <= i < ndays:
                days[i] += v
    days = [int(v) for v in days]
    total = sum(s['active_ms'] for s in in_month)
    ranked = totals(in_month)
    top = []
    for i, (rom_id, t) in enumerate(ranked[:TOP_RECAP_GAMES]):
        g = games.get(rom_id) or {}
        top.append({
            'rom_id': rom_id, 'name': g.get('name') or '', 'platform': g.get('platform_name') or '',
            'ms': int(t['ms']), 'sessions': t['sessions'], 'share': t['ms'] / total if total else 0,
            # Argosy's "New": one of the month's top three that was not in the
            # month before's.
            'new': i < FAVORITES_TOP and rom_id not in prev_top,
            'first_play': first_played.get(rom_id, start) >= start,
        })
    busiest = max(range(ndays), key=lambda i: days[i]) if total else None

    # Unlocks dated in the month, one per badge, oldest first.
    unlocks, awards = {}, []
    for prog in progression:
        ra_id = prog.get('rom_ra_id')
        info = ra_games.get(ra_id) or {}
        for e in prog.get('earned_achievements') or []:
            at = _parse_utc(e.get('date'))
            bid = str(e.get('id') or '')
            if not bid or at is None or not (start <= at < end):
                continue
            a = (info.get('achievements') or {}).get(bid) or {}
            key = (ra_id, bid)
            if key in unlocks and unlocks[key]['at'] <= at:
                continue
            unlocks[key] = {
                'badge_id': bid, 'at': at, 'ra_game_id': ra_id,
                'rom_id': info.get('rom_id'), 'game': info.get('name') or '',
                'title': a.get('title') or '', 'description': a.get('description') or '',
                'points': a.get('points') or 0, 'badge_url': a.get('badge_url')
                or f'https://media.retroachievements.org/Badge/{bid}.png',
            }
        # RomM 5.4 names no award; like Argosy's RomM path, a game is
        # mastered (hardcore) or completed once every achievement is earned,
        # dated by its most recent unlock.
        most = prog.get('max_possible') or 0
        kind = ('mastered' if most and (prog.get('num_awarded_hardcore') or 0) >= most
                else 'completed' if most and (prog.get('num_awarded') or 0) >= most else None)
        at = _parse_utc(prog.get('most_recent_awarded_date'))
        if kind and at is not None and start <= at < end:
            awards.append({'kind': kind, 'at': at, 'ra_game_id': ra_id,
                           'rom_id': info.get('rom_id'), 'game': info.get('name') or ''})
    unlocks = sorted(unlocks.values(), key=lambda u: u['at'])
    awards.sort(key=lambda a: a['at'])

    return {
        'month': month,
        'prev': _shift_month(month, -1),
        'next': _shift_month(month, 1),
        'total_ms': int(total),
        'sessions': len(in_month),
        'longest_ms': max((s['active_ms'] for s in in_month), default=0),
        'days': days,
        'days_played': sum(1 for v in days if v > 0),
        'busiest_day': None if busiest is None else {'day': busiest + 1, 'ms': days[busiest]},
        'top_games': top,
        'other_games': max(0, len(ranked) - len(top)),
        'other_ms': int(sum(t['ms'] for _, t in ranked[TOP_RECAP_GAMES:])),
        'unlocks': unlocks,
        'points': sum(u['points'] for u in unlocks),
        'awards': awards,
    }


def recap_months(sessions, progression=None):
    """'YYYY-MM' months with play or unlocks, newest first."""
    months = {datetime.fromtimestamp(s['start']).strftime('%Y-%m')
              for s in sessions if s.get('rom_id') is not None}
    for prog in progression or []:
        for e in prog.get('earned_achievements') or []:
            at = _parse_utc(e.get('date'))
            if at is not None:
                months.add(datetime.fromtimestamp(at).strftime('%Y-%m'))
    return sorted(months, reverse=True)
