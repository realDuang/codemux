import type { QuestionInfo, UnifiedQuestion } from "../../../../src/types/unified";

type Primitive = string | number | boolean;
type FormValue = Primitive | Primitive[];
export interface DesktopElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content: Record<string, FormValue> | null;
  _meta: null;
}
interface Choice { label: string; value: Primitive }
interface Field {
  name: string;
  required: boolean;
  schema: Record<string, unknown>;
  type: "string" | "number" | "integer" | "boolean" | "array";
  choices?: Choice[];
}
interface Form {
  fields: Field[];
  unsupportedReason?: string;
  externalUrl?: string;
}

const ACTIONS = { Accept: "accept", Decline: "decline", Cancel: "cancel" } as const;
const MAX_FIELDS = 40;
const MAX_CHOICES = 100;
const OBJECT_KEYS = new Set(["type", "properties", "required", "additionalProperties", "title", "description", "$schema"]);
const FIELD_KEYS = new Set([
  "type", "title", "description", "default", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "format",
]);
const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** Keep unsupported requests visible and cancellable instead of silently waiting. */
export function convertDesktopElicitationToQuestion(sessionId: string, requestId: string | number, params: Record<string, unknown>): UnifiedQuestion {
  const form = compileForm(params);
  const actions = form.unsupportedReason ? ["Decline", "Cancel"] : ["Accept", "Decline", "Cancel"];
  const message = typeof params.message === "string" && params.message ? params.message : "An MCP server is requesting a response.";
  const serverName = typeof params.serverName === "string" ? params.serverName : "MCP server";
  return {
    id: String(requestId), sessionId, engineType: "codex-desktop", dismissStopsTurn: false,
    ...(form.externalUrl ? { externalUrl: form.externalUrl } : {}),
    questions: [{
      header: serverName.slice(0, 30), question: form.unsupportedReason ? `${message}\n\n${form.unsupportedReason}` : message,
      custom: false, multiple: false,
      options: actions.map((label) => ({ label, description: label === "Accept" ? "Submit the form values below." : label === "Decline" ? "Decline this request." : "Cancel this request." })),
    }, ...form.fields.map(fieldQuestion)],
    metadata: { kind: "mcp-elicitation", mode: typeof params.mode === "string" ? params.mode : "unsupported", supportedForm: !form.unsupportedReason },
  };
}

/** Rebuild from the still-pending native request, never from client-supplied schema. */
export function buildDesktopElicitationResponse(params: Record<string, unknown>, answers: string[][]): DesktopElicitationResponse {
  const form = compileForm(params);
  const selected = answers[0];
  if (!Array.isArray(selected) || selected.length !== 1 || !Object.hasOwn(ACTIONS, selected[0])) throw new Error("Choose one elicitation action.");
  const action = ACTIONS[selected[0] as keyof typeof ACTIONS];
  if (action !== "accept") return { action, content: null, _meta: null };
  if (form.unsupportedReason) throw new Error("This elicitation requires the original Codex client.");
  if (answers.length > form.fields.length + 1 && answers.slice(form.fields.length + 1).some((answer) => answer.length > 0)) throw new Error("The form contains unexpected answers.");
  const entries: Array<[string, FormValue]> = [];
  form.fields.forEach((field, index) => {
    const selectedValues = answers[index + 1] ?? [];
    if (!Array.isArray(selectedValues) || selectedValues.some((value) => typeof value !== "string")) throw fieldError(field, "Invalid answer format.");
    const value = parseField(field, selectedValues);
    if (value !== undefined) entries.push([field.name, value]);
  });
  return { action, content: Object.fromEntries(entries), _meta: null };
}

export function cancelDesktopElicitation(): DesktopElicitationResponse {
  return { action: "cancel", content: null, _meta: null };
}

function compileForm(params: Record<string, unknown>): Form {
  const metadata = record(params._meta);
  if (params.mode !== "form" && params.mode !== "url") return unsupported("This request uses a specialized Codex form. Continue in Codex, or decline or cancel here.");
  if (metadata && ["codex_approval_kind", "openai/confirmation", "browser_auth_challenge_id", "_codex_apps"].some((key) => Object.hasOwn(metadata, key))) {
    return unsupported("This request requires Codex's original authorization interface. Decline or cancel here, or continue in Codex.");
  }
  if (params.mode === "url") {
    const externalUrl = safeExternalUrl(params.url);
    return externalUrl ? { fields: [], externalUrl } : unsupported("This request does not contain a supported HTTP or HTTPS link.");
  }
  try {
    const schema = record(params.requestedSchema);
    if (!schema || schema.type !== "object") throw new Error("Only object forms are supported.");
    checkKeys(schema, OBJECT_KEYS);
    if (Object.hasOwn(schema, "additionalProperties") && typeof schema.additionalProperties !== "boolean") throw new Error("Additional-property schemas are not supported.");
    const properties = record(schema.properties);
    if (!properties || Object.keys(properties).length > MAX_FIELDS) throw new Error("This form has unsupported fields.");
    const required = Object.hasOwn(schema, "required") ? schema.required : [];
    if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name)) || new Set(required).size !== required.length) throw new Error("The form's required fields are invalid.");
    const fields = Object.entries(properties).map(([name, value]) => {
      if (["__proto__", "prototype", "constructor"].includes(name)) throw new Error("This form contains an unsupported field name.");
      const fieldSchema = record(value);
      if (!fieldSchema) throw new Error("This form contains an unsupported field schema.");
      return compileField(name, required.includes(name), fieldSchema);
    });
    return { fields };
  } catch {
    return unsupported("This form uses unsupported schema constraints. Continue in Codex, or decline or cancel here.");
  }
}

function compileField(name: string, required: boolean, schema: Record<string, unknown>): Field {
  checkKeys(schema, FIELD_KEYS);
  const type = schema.type;
  if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") throw new Error("Unsupported field type");
  const field: Field = { name, required, schema, type };
  if (Object.hasOwn(schema, "title") && typeof schema.title !== "string") throw new Error("Invalid title");
  if (Object.hasOwn(schema, "description") && typeof schema.description !== "string") throw new Error("Invalid description");
  if (type === "array") {
    if (["enum", "oneOf", "enumNames"].some((key) => Object.hasOwn(schema, key))) throw new Error("Array-level enums are unsupported");
    const items = record(schema.items);
    if (!items || items.type === "array") throw new Error("Only primitive enum arrays are supported");
    const item = compileField(name, true, items);
    if (!item.choices) throw new Error("Only enum arrays are supported");
    field.choices = item.choices;
    checkNonnegativeInteger(schema, "minItems");
    checkNonnegativeInteger(schema, "maxItems");
    if (Object.hasOwn(schema, "uniqueItems") && typeof schema.uniqueItems !== "boolean") throw new Error("Invalid uniqueItems");
    if (numeric(schema.minItems) && numeric(schema.maxItems) && schema.minItems > schema.maxItems) throw new Error("Invalid item bounds");
    // Item constraints are checked against every selected enum value below.
    for (const choice of item.choices) validatePrimitive(item, choice.value);
  } else {
    if (["items", "minItems", "maxItems", "uniqueItems"].some((key) => Object.hasOwn(schema, key))) throw new Error("Array constraints on a primitive");
    field.choices = compileChoices(schema, type);
    if (type === "boolean" && !field.choices) field.choices = [{ label: "True", value: true }, { label: "False", value: false }];
  }
  if (type === "string") {
    checkNonnegativeInteger(schema, "minLength");
    checkNonnegativeInteger(schema, "maxLength");
    if (numeric(schema.minLength) && numeric(schema.maxLength) && schema.minLength > schema.maxLength) throw new Error("Invalid length bounds");
    if (Object.hasOwn(schema, "format") && (typeof schema.format !== "string" || !STRING_FORMATS.has(schema.format))) throw new Error("Unsupported string format");
  } else if (["minLength", "maxLength", "format"].some((key) => Object.hasOwn(schema, key))) throw new Error("String constraints on another type");
  if (type === "number" || type === "integer") {
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      if (Object.hasOwn(schema, key) && !numeric(schema[key])) throw new Error("Invalid numeric constraint");
    }
    if (numeric(schema.multipleOf) && schema.multipleOf <= 0) throw new Error("Invalid multipleOf");
  } else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => Object.hasOwn(schema, key))) throw new Error("Numeric constraints on another type");
  if (field.choices && type !== "array") for (const choice of field.choices) validatePrimitive(field, choice.value);
  return field;
}

function compileChoices(schema: Record<string, unknown>, type: string): Choice[] | undefined {
  let values: unknown[] | undefined;
  let names: unknown[] | undefined;
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || Object.hasOwn(schema, "oneOf")) throw new Error("Invalid enum");
    values = schema.enum;
    if (Object.hasOwn(schema, "enumNames")) {
      if (!Array.isArray(schema.enumNames)) throw new Error("Invalid enum names");
      names = schema.enumNames;
    }
  } else if (Object.hasOwn(schema, "oneOf")) {
    if (!Array.isArray(schema.oneOf) || Object.hasOwn(schema, "enumNames")) throw new Error("Invalid enum alternatives");
    values = [];
    names = [];
    for (const value of schema.oneOf) {
      const choice = record(value);
      if (!choice || Object.keys(choice).some((key) => key !== "const" && key !== "title") || !Object.hasOwn(choice, "const")) throw new Error("Only named enum alternatives are supported");
      values.push(choice.const);
      names.push(choice.title ?? displayPrimitive(choice.const));
    }
  } else if (Object.hasOwn(schema, "enumNames")) throw new Error("Enum names without values");
  if (!values) return undefined;
  if (values.length === 0 || values.length > MAX_CHOICES || (names && names.length !== values.length)) throw new Error("Invalid enum size");
  const choices = values.map((value, index) => {
    if (!primitiveMatches(value, type)) throw new Error("Enum value type mismatch");
    const label = names?.[index] ?? displayPrimitive(value);
    if (typeof label !== "string" || !label) throw new Error("Invalid enum label");
    return { label, value: value as Primitive };
  });
  if (new Set(choices.map((choice) => choice.label)).size !== choices.length || new Set(choices.map((choice) => JSON.stringify(choice.value))).size !== choices.length) throw new Error("Ambiguous enum labels or values");
  return choices;
}

function fieldQuestion(field: Field): QuestionInfo {
  const title = typeof field.schema.title === "string" ? field.schema.title : field.name;
  const description = typeof field.schema.description === "string" ? field.schema.description : "";
  return {
    header: title.slice(0, 30), question: `${title}${field.required ? " (required)" : " (optional; leave blank to omit)"}${description ? `\n${description}` : ""}`,
    options: (field.choices ?? []).map((choice) => ({ label: choice.label, description: "" })),
    multiple: field.type === "array", custom: !field.choices,
    ...(field.type === "string" && !field.choices ? { preserveWhitespace: true, ...(field.required ? { allowEmptyAnswer: true } : {}) } : {}),
  };
}

function parseField(field: Field, answers: string[]): FormValue | undefined {
  const { schema } = field;
  if (field.type === "array") {
    if (answers.length === 0 && !field.required) return undefined;
    const values = answers.map((answer) => selectedChoice(field, answer));
    if (numeric(schema.minItems) && values.length < schema.minItems) throw fieldError(field, "Select more values.");
    if (numeric(schema.maxItems) && values.length > schema.maxItems) throw fieldError(field, "Too many selected values.");
    if (schema.uniqueItems === true && new Set(values.map((value) => JSON.stringify(value))).size !== values.length) throw fieldError(field, "Duplicate values are not allowed.");
    return values;
  }
  if (answers.length === 0 || (!field.required && answers.length === 1 && answers[0] === "")) {
    if (field.required) throw fieldError(field, "A value is required.");
    return undefined;
  }
  if (answers.length !== 1) throw fieldError(field, "Choose one value.");
  let value: Primitive;
  if (field.choices) value = selectedChoice(field, answers[0]);
  else if (field.type === "string") value = answers[0];
  else {
    const text = answers[0].trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) throw fieldError(field, "Enter a finite number.");
    value = Number(text);
  }
  validatePrimitive(field, value);
  return value;
}

function selectedChoice(field: Field, label: string): Primitive {
  const choice = field.choices?.find((choice) => choice.label === label);
  if (!choice) throw fieldError(field, "Choose one of the offered values.");
  return choice.value;
}

function validatePrimitive(field: Field, value: Primitive): void {
  if (!primitiveMatches(value, field.type)) throw fieldError(field, "The value has an unsupported type or precision.");
  const schema = field.schema;
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (numeric(schema.minLength) && length < schema.minLength) throw fieldError(field, "The value is too short.");
    if (numeric(schema.maxLength) && length > schema.maxLength) throw fieldError(field, "The value is too long.");
    if (typeof schema.format === "string" && !validStringFormat(schema.format, value)) throw fieldError(field, "The value does not match the required format.");
  } else if (typeof value === "number") {
    if ((numeric(schema.minimum) && value < schema.minimum) || (numeric(schema.maximum) && value > schema.maximum) ||
      (numeric(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) || (numeric(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum)) throw fieldError(field, "The value is outside the allowed range.");
    if (numeric(schema.multipleOf)) {
      const quotient = value / schema.multipleOf;
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4) throw fieldError(field, "The value is not an allowed multiple.");
    }
  }
}

function validStringFormat(format: string, value: string): boolean {
  if (format === "uri") {
    if (!/^[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/i.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return false;
    try { return Boolean(new URL(value).protocol); } catch { return false; }
  }
  if (format === "email") {
    const [local = "", domain = ""] = value.split("@");
    return value.length <= 254 && local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(domain) && value.split("@").length === 2;
  }
  if (format === "date") return validDate(value);
  if (format === "date-time") {
    const match = /^(\d{4}-\d{2}-\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|[+-](\d{2}):(\d{2}))$/.exec(value);
    return Boolean(match && validDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 60 && Number(match[5] ?? 0) <= 23 && Number(match[6] ?? 0) <= 59);
  }
  return false;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function checkKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  // Patterns and composition keywords are intentionally unsupported. Executing
  // untrusted regular expressions in the gateway can block all client sessions.
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Unsupported schema constraint");
}
function checkNonnegativeInteger(schema: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(schema, key) && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0)) throw new Error("Invalid bound");
}
function primitiveMatches(value: unknown, type: string): boolean {
  return type === "string" ? typeof value === "string" : type === "boolean" ? typeof value === "boolean"
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : type === "number" && numeric(value);
}
function displayPrimitive(value: unknown): string { return value === "" ? "(empty string)" : String(value); }
function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function unsupported(reason: string): Form { return { fields: [], unsupportedReason: reason }; }
function fieldError(field: Field, message: string): Error { return new Error(`${field.name}: ${message}`); }
