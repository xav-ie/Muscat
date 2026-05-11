// Tagged template literal for SVG path-data and attribute strings, allowing
// numeric values to be interpolated without explicit String() wrapping at
// every call site. The helper applies String() centrally; the value type is
// explicit `string | number` so the type system still checks each arg.
//
// `@typescript-eslint/restrict-template-expressions` does not fire on tagged
// templates (the values are passed as arguments, not coerced inline), so this
// is the proper architectural fix rather than a per-site bypass.
//
//     const d = svg`M ${x} ${y} L ${x + w} ${y}`;
export function svg(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let result = "";
  for (const [index, string_] of strings.entries()) {
    result += string_;
    if (index < values.length) result += String(values[index]);
  }
  return result;
}
