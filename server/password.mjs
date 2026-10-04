import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('PASSWORD_LENGTH_12_TO_256');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, options);
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [version, salt, hex] = (stored || '').split('$');
  if (version !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hex)) return false;
  const key = await scrypt(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
