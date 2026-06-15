// Example: formatMessage("Hello {name}", { name: "World" }) => "Hello World"
export function formatMessage(
  template: string,
  values?: Record<string, string | number>,
): string {
  if (!values) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (_, key) => String(values[key] ?? `{${key}}`),
  );
}
