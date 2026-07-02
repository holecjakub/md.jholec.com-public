import { hash, verify, type Options } from "@node-rs/argon2";

// Algorithm.Argon2id === 2. We use the numeric literal because `Algorithm` is an
// ambient const enum, which `verbatimModuleSyntax` forbids accessing as a value.
// Explicit OWASP-aligned parameters (security review L1): the library defaults
// (memoryCost 4 MiB) sit below the OWASP Argon2id floor of 19 MiB.
const OPTIONS = {
  algorithm: 2,
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const satisfies Options;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(encoded: string, plain: string): Promise<boolean> {
  try {
    return await verify(encoded, plain, OPTIONS);
  } catch {
    return false;
  }
}
