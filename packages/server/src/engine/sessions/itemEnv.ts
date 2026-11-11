/**
 * What every worker session and the commands planestro runs for it are told (#544): the item they work for, so a
 * project's own scripts can tell a planestro worker from CI or a person (a test runner may keep its whole suite for CI).
 * Not a secret, and a name secret_env may not take.
 */
export function itemEnv(itemId: string): Record<string, string> { return { PLANESTRO_ITEM: itemId }; }
