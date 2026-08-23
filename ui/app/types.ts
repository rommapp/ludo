// The two shapes the library is made of.
//
// A group is anything the grid can be a grid OF — a platform, a collection, a
// saved search. A game is one rom as the browser needs it, which is a subset of
// what RomM returns: the backend trims the rest before it crosses the wire.

export interface LibGroup {
  key: string; label: string; count: number; downloaded: number | null;
  kind?: 'favorite' | 'smart' | 'virtual' | 'collection'; covers?: string[];
  slug?: string | null; fs_slug?: string | null;
  synced?: boolean; virtual?: boolean;
}

export interface LibGame { rom_id: number; name: string; platform: string | null; is_downloaded: boolean; has_cover: boolean; screenshot?: string | null; platform_slug?: string | null; is_multi_disc?: boolean; disc_count?: number; sibling_roms?: { rom_id: number; name: string }[]; region_count?: number; is_orphan?: boolean; regions?: string[]; languages?: string[]; }
