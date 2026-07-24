import { randomBytes } from 'crypto';

/** 放映室业务 key，字段名固定 season_id */
export function generateSeasonId(length = 16): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}
