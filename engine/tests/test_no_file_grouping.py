"""A version RomM has no file for can't be the tile while another has one."""
from romm_sync_engine.sync_core import RomMClient


def group(rows):
    return RomMClient._group_sibling_roms(None, rows)


def row(i, others, ext='bin', has_file=True, main=False):
    return {'id': i, 'fs_extension': ext, 'has_file_on_disk': has_file,
            'rom_user': {'is_main_sibling': main},
            'sibling_roms': [{'id': o} for o in others]}


# Added first and lowest id, so it used to win the tile.
assert group([row(1, [2], '7z', False), row(2, [1])])[0]['id'] == 2
# Even when marked as main.
assert group([row(1, [2], has_file=False, main=True), row(2, [1])])[0]['id'] == 2
# A folder with no file doesn't win, and doesn't prune the versions that work.
g = group([row(1, [2, 3], '', False), row(2, [1, 3]), row(3, [1, 2])])[0]
assert g['id'] == 2 and {s['id'] for s in g['sibling_roms']} == {1, 3}
# A working folder still wins over members with no file.
assert group([row(1, [3], 'nds', False), row(3, [1], '')])[0]['id'] == 3
# Nothing has a file: still one entry.
assert group([row(1, [2], has_file=False), row(2, [1], has_file=False)])[0]['id'] == 1
# Rows that don't report the field group as before.
a, b = row(1, [2]), row(2, [1])
del a['has_file_on_disk'], b['has_file_on_disk']
assert group([a, b])[0]['id'] == 1
print('ok')

# Region priority (#71): RomM's order, unknown codes skipped.
from romm_sync_engine.sync_core import region_ranks_for_priority, filename_region_rank
ranks = region_ranks_for_priority(['us', 'ss', 'eu', 'jp'])
assert ranks == {'usa': 0, 'europe': 1, 'japan': 2}
assert filename_region_rank('G (Europe, Japan).nds', ranks) == 1
assert filename_region_rank('G (Brazil).nds', ranks) == 4


class Client:
    region_ranks = lambda self: ranks
    group = RomMClient._group_sibling_roms


def reg(i, others, region, name='g.bin', **kw):
    return dict(row(i, others, **kw), regions=[region], fs_name=name)


c = Client()
assert c.group([reg(1, [2], 'Japan'), reg(2, [1], 'Europe')])[0]['id'] == 2
assert c.group([reg(1, [2], 'Brazil'), reg(2, [1], 'Japan')])[0]['id'] == 2
# A pre-release loses to a full release, whatever its region.
assert c.group([reg(1, [2], 'USA', 'g (Beta).bin'), reg(2, [1], 'Japan')])[0]['id'] == 2
# The user's main and a folder still win.
assert c.group([reg(1, [2], 'Japan', main=True), reg(2, [1], 'USA')])[0]['id'] == 1
assert c.group([reg(1, [2], 'Japan', ext=''), reg(2, [1], 'USA')])[0]['id'] == 1
# A file beats the preferred region.
assert c.group([reg(1, [2], 'USA', has_file=False), reg(2, [1], 'Japan')])[0]['id'] == 2
print('ok ranks')
