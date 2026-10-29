import { describe, expect, it } from "vitest";
import { clientIp } from "../view-handlers";

const req = (headers: Record<string, string>) => new Request("https://demo.test/api/demo/scenarios", { headers });

describe("clientIp", () => {
  it("prefiere x-real-ip (la fija el edge) sobre x-forwarded-for (manipulable por el cliente)", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "203.0.113.77, 100.64.0.2" }))).toBe("198.51.100.4");
  });

  it("sin x-real-ip usa la primera entrada de x-forwarded-for y, sin ninguna, 'local'", () => {
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.5, 100.64.0.2" }))).toBe("198.51.100.5");
    expect(clientIp(req({}))).toBe("local");
  });
});
