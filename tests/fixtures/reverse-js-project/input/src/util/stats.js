import { add } from '../math.js';

export function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

export function scale(values, factor) {
  return values.map((value) => add(value, factor));
}
