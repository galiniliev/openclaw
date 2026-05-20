export interface EndpointConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, ParamConfig>;
  body?: boolean;
  headers?: Record<string, string>;
}

export interface ParamConfig {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: unknown;
  in?: "path" | "query" | "body";
}

export interface ParsedEndpoint {
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  headers?: Record<string, string>;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export function parseEndpointShorthand(shorthand: string): ParsedEndpoint {
  const spaceIdx = shorthand.indexOf(" ");
  if (spaceIdx === -1) {
    throw new Error(`Invalid endpoint shorthand: "${shorthand}" — expected "METHOD /path"`);
  }

  const method = shorthand.slice(0, spaceIdx).toUpperCase();
  const rest = shorthand.slice(spaceIdx + 1);

  const [pathPart, queryPart] = rest.split("?", 2);

  const pathParams: string[] = [];
  for (const match of pathPart.matchAll(/\{(\w+)\}/g)) {
    pathParams.push(match[1]);
  }

  const queryParams: string[] = [];
  if (queryPart) {
    for (const match of queryPart.matchAll(/\{(\w+)\}/g)) {
      queryParams.push(match[1]);
    }
  }

  return {
    method,
    path: pathPart,
    pathParams,
    queryParams,
    hasBody: BODY_METHODS.has(method),
  };
}

export function parseEndpointConfig(config: string | EndpointConfig): ParsedEndpoint {
  if (typeof config === "string") {
    return parseEndpointShorthand(config);
  }

  const pathParams: string[] = [];
  const queryParams: string[] = [];

  if (config.params) {
    for (const [name, param] of Object.entries(config.params)) {
      const location = param.in ?? (config.path.includes(`{${name}}`) ? "path" : "query");
      if (location === "path") {
        pathParams.push(name);
      } else if (location === "query") {
        queryParams.push(name);
      }
    }
  } else {
    for (const match of config.path.matchAll(/\{(\w+)\}/g)) {
      pathParams.push(match[1]);
    }
  }

  return {
    method: config.method,
    path: config.path,
    pathParams,
    queryParams,
    hasBody: config.body ?? BODY_METHODS.has(config.method),
    headers: config.headers,
  };
}
