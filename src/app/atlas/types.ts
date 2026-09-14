/** Shared shape between the atlas page and its map. */
export interface Entity {
  name: string;
  description: string;
  scope?: string;
  signals?: string[];
  notThis?: string[];
  parent?: string;
  group?: string;
  aliases?: string[];
  notes?: string;
  usage: { owners: number; claims: number; touched: number };
}
