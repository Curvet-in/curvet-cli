import { describe, expect, it } from "vitest";
import { resolveRoute } from "../src/commands/proxy.js";

describe("resolveRoute", () => {
  // Tools disagree about whether the base URL they are handed already ends in
  // /v1, so both spellings have to land on the same upstream path.
  it("accepts a path with or without the /v1 prefix", () => {
    expect(resolveRoute("POST", "/v1/chat/completions")).toBe("/chat/completions");
    expect(resolveRoute("POST", "/chat/completions")).toBe("/chat/completions");
    expect(resolveRoute("GET", "/v1/models")).toBe("/models");
    expect(resolveRoute("GET", "/models")).toBe("/models");
  });

  it("passes a model id through to the single-model route", () => {
    expect(resolveRoute("GET", "/v1/models/gpt-5.5")).toBe("/models/gpt-5.5");
  });

  it("refuses a route it does not serve, rather than forwarding blindly", () => {
    expect(resolveRoute("GET", "/v1/embeddings")).toBeUndefined();
    expect(resolveRoute("POST", "/v1/images/generations")).toBeUndefined();
    expect(resolveRoute("DELETE", "/v1/models")).toBeUndefined();
  });

  it("does not match a path that merely contains a served route", () => {
    expect(resolveRoute("POST", "/evil/v1/chat/completions")).toBeUndefined();
  });

  // The proxy holds a credential and hands it to whatever connects, so a route
  // that climbs out of the API base would reach arbitrary upstream paths with
  // that key attached. fetch normalises `/api/v1/models/../../secret` to
  // `/secret`, so the model id must stay a single segment.
  it("refuses a model id that escapes the API base", () => {
    expect(resolveRoute("GET", "/models/../../secret")).toBeUndefined();
    expect(resolveRoute("GET", "/v1/models/..%2F..%2Fsecret")).toBe("/models/..%2F..%2Fsecret");
    expect(resolveRoute("GET", "/models/a/b")).toBeUndefined();
  });
});
