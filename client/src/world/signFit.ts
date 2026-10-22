/** Steps `size` down by 2 until `measure(size)` fits `maxWidth`, down to `min`; never returns more than `size`. */
export function fitSize(measure: (size: number) => number, size: number, maxWidth: number, min = 20): number {
  let s = size;
  while (s > min && measure(s) > maxWidth) s -= 2;
  return s;
}
