import { describe, expect, it } from "vitest";
import { runConnectionDiagnostics } from "../src/connectionDiagnostics.js";
import { PinMismatchError } from "../src/pinnedTransport.js";

const healthyBody = { ok: true, name: "vault-rooms", version: "0.2.1" };

describe("runConnectionDiagnostics", () => {
  it("fails parse-url for garbage and non-http schemes without probing the network", async () => {
    let probed = false;
    const probes = {
      pinned: false,
      fetchHealth: async () => {
        probed = true;
        return { status: 200, body: healthyBody };
      }
    };

    const garbage = await runConnectionDiagnostics("not a url", probes);
    expect(garbage.ok).toBe(false);
    expect(garbage.steps[0]).toMatchObject({ id: "parse-url", status: "fail" });
    expect(garbage.steps.slice(1).every((step) => step.status === "skipped")).toBe(true);

    const ftp = await runConnectionDiagnostics("ftp://192.168.1.10:8787", probes);
    expect(ftp.ok).toBe(false);
    expect(ftp.steps[0]).toMatchObject({ id: "parse-url", status: "fail" });
    expect(probed).toBe(false);
  });

  it("fails reach-server with a network hint when nothing answers", async () => {
    const report = await runConnectionDiagnostics("http://192.168.1.10:8787", {
      pinned: false,
      fetchHealth: async () => {
        throw new Error("Request timed out.");
      }
    });
    expect(report.ok).toBe(false);
    const reach = report.steps.find((step) => step.id === "reach-server");
    expect(reach?.status).toBe("fail");
    expect(reach?.detail).toContain("Request timed out.");
    expect(reach?.detail).toContain("firewall");
    expect(report.steps.find((step) => step.id === "identify-server")?.status).toBe("skipped");
  });

  it("reports a pin mismatch as an identity failure, not unreachability", async () => {
    const report = await runConnectionDiagnostics("https://192.168.1.10:8787", {
      pinned: true,
      fetchHealth: async () => {
        throw new PinMismatchError("presented", "pinned");
      }
    });
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === "reach-server")?.status).toBe("pass");
    const identify = report.steps.find((step) => step.id === "identify-server");
    expect(identify?.status).toBe("fail");
    expect(identify?.detail).toContain("different identity");
  });

  it("fails identify-server when something else answers on the port", async () => {
    const report = await runConnectionDiagnostics("http://192.168.1.10:8787", {
      pinned: false,
      fetchHealth: async () => ({ status: 200, body: "<html>router admin</html>" })
    });
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === "reach-server")?.status).toBe("pass");
    expect(report.steps.find((step) => step.id === "identify-server")?.status).toBe("fail");
  });

  it("skips the authenticate step entirely when no login is saved", async () => {
    const report = await runConnectionDiagnostics("http://192.168.1.10:8787", {
      pinned: false,
      fetchHealth: async () => ({ status: 200, body: healthyBody })
    });
    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.id)).toEqual(["parse-url", "reach-server", "identify-server"]);
    expect(report.steps.every((step) => step.status === "pass")).toBe(true);
  });

  it("explains an UNAUTHORIZED /api/me as a stale saved login", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized."), { code: "UNAUTHORIZED" });
    const report = await runConnectionDiagnostics("http://192.168.1.10:8787", {
      pinned: false,
      fetchHealth: async () => ({ status: 200, body: healthyBody }),
      fetchMe: async () => {
        throw unauthorized;
      }
    });
    expect(report.ok).toBe(false);
    const auth = report.steps.find((step) => step.id === "authenticate");
    expect(auth?.status).toBe("fail");
    expect(auth?.detail).toContain("no longer recognizes");
  });

  it("passes all four steps against a healthy server with a valid login", async () => {
    const report = await runConnectionDiagnostics("http://192.168.1.10:8787", {
      pinned: false,
      fetchHealth: async () => ({ status: 200, body: healthyBody }),
      fetchMe: async () => undefined
    });
    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.id)).toEqual(["parse-url", "reach-server", "identify-server", "authenticate"]);
    expect(report.steps.every((step) => step.status === "pass")).toBe(true);
    expect(report.steps.find((step) => step.id === "identify-server")?.detail).toContain("0.2.1");
  });
});
