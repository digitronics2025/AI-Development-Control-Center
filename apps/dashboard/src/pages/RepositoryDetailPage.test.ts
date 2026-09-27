import { describe, expect, it } from 'vitest';
import { themesChoice, widthsChoice } from './RepositoryDetailPage';

describe('App runtime choices', () => {
  it('name the two presets in any order, and show any other saved list as custom (kept until changed here)', () => {
    expect(widthsChoice(['desktop', 'phone'])).toBe('standard');
    expect(widthsChoice(['phone', 'desktop'])).toBe('standard');
    expect(widthsChoice(['wide', 'desktop', 'narrow-desktop', 'tablet', 'phone'])).toBe('all');
    expect(widthsChoice(['phone', 'tablet'])).toBe('custom');
    expect(themesChoice([])).toBe('default');
    expect(themesChoice(['dark', 'light'])).toBe('both');
    expect(themesChoice(['dark'])).toBe('custom');
  });
});
