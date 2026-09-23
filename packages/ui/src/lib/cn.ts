import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the custom type scale so `text-small` and `text-fg`
// are not treated as conflicting classes.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'h1', 'h2', 'h3', 'body', 'small', 'code'] }],
    },
  },
});

/** The single class-composition helper for every component. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
