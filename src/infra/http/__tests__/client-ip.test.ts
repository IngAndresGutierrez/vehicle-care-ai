import { describe, expect, it } from "vitest";
import { clientIp } from "../view-handlers";

const req = (headers: Record<string, string>) => new Request("https://demo.test/api/demo/scenarios", { headers });

describe("clientIp", () => {
  it("usa la IP que añade el proxy (última entrada), no la que envía el cliente", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.77, 198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("una sola entrada (proxy que reemplaza la cabecera)", () => {
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("sin x-forwarded-for usa x-real-ip y, sin ninguna, 'local'", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(clientIp(req({}))).toBe("local");
  });
});
