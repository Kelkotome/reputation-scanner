import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

describe('fetch options the Workers runtime accepts', () => {
  it("never uses redirect:'error', which throws at runtime", () => {
    for (const file of readdirSync('src').filter(name => name.endsWith('.js'))) {
      const code = readFileSync(`src/${file}`, 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      expect(code, file).not.toMatch(/redirect:\s*['"]error['"]/);
    }
  });
});
