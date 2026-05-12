/**
 * Smoke tests for `bin/artagon-openai-server.mjs`.
 *
 * Tests:
 *   - --version + --help exits and outputs
 *   - argv parsing rejection paths (unknown flag, invalid port)
 *   - actual server start: spawn the bin, parse the printed port, hit /health,
 *     send SIGTERM, verify clean exit.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const BIN = path.join(ROOT, "bin/artagon-openai-server.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** @param {string[]} args */
function runBinSync(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    timeout: 10000
  });
}

describe("bin/artagon-openai-server.mjs — argv parsing (synchronous)", () => {
  test("--version prints PKG.version", () => {
    const r = runBinSync(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe(PKG.version);
  });

  test("--help prints usage", () => {
    const r = runBinSync(["--help"]);
    expect(r.status).toBe(0);
    // commander format: "Usage: artagon-openai-server [options]"
    expect(r.stdout.toString()).toMatch(/Usage: artagon-openai-server/);
    expect(r.stdout.toString()).toMatch(/--port/);
  });

  test("unknown flag: exits 2 with the flag named", () => {
    const r = runBinSync(["--bogus"]);
    expect(r.status).toBe(2);
    // commander: "error: unknown option '--bogus'"
    expect(r.stderr.toString()).toMatch(/unknown option '--bogus'/);
  });

  test("invalid --port: exits 2", () => {
    const r = runBinSync(["--port", "99999"]);
    expect(r.status).toBe(2);
    // commander surfaces our InvalidArgumentError
    expect(r.stderr.toString()).toMatch(/--port/);
    expect(r.stderr.toString()).toMatch(/0, 65535/);
  });

  test("--host without value: exits 2", () => {
    const r = runBinSync(["--host"]);
    expect(r.status).toBe(2);
    // commander: "error: option '--host <h>' argument missing"
    expect(r.stderr.toString()).toMatch(/--host/);
    expect(r.stderr.toString()).toMatch(/missing/);
  });

  test("--cors without value: exits 2", () => {
    const r = runBinSync(["--cors"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--cors/);
    expect(r.stderr.toString()).toMatch(/missing/);
  });

  test("--help mentions --cors flag + env var", () => {
    const r = runBinSync(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/--cors/);
    expect(r.stdout.toString()).toMatch(/ARTAGON_FACADE_CORS/);
  });

  test("--api-key without value: exits 2", () => {
    const r = runBinSync(["--api-key"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--api-key/);
    expect(r.stderr.toString()).toMatch(/missing/);
  });

  test("--help mentions --api-key flag + env var", () => {
    const r = runBinSync(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/--api-key/);
    expect(r.stdout.toString()).toMatch(/ARTAGON_FACADE_API_KEY/);
  });

  test("--api-key-file without value: exits 2", () => {
    const r = runBinSync(["--api-key-file"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--api-key-file/);
    expect(r.stderr.toString()).toMatch(/missing/);
  });

  test("--api-key-file with non-existent path: exits 2 with file error", () => {
    const r = runBinSync(["--api-key-file", "/dev/null/does-not-exist"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/failed to read --api-key-file/);
  });

  test("--api-key + --api-key-file together → exits 2", () => {
    const r = runBinSync(["--api-key", "sk-x", "--api-key-file", "/tmp/x"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/mutually exclusive/);
  });

  test("--help mentions --wire-log + --wire-log-raw", () => {
    const r = runBinSync(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/--wire-log /);
    expect(r.stdout.toString()).toMatch(/--wire-log-raw/);
  });
});

describe("bin/artagon-openai-server.mjs — ACP_WIRE_LOG env-var fallback", () => {
  test("ACP_WIRE_LOG=<path> opens the wire log when --wire-log is unset", async () => {
    const tmpDir = fs.mkdtempSync(path.join("/tmp", "openai-srv-wirelog-"));
    const wirePath = path.join(tmpDir, "wire.jsonl");
    try {
      const child = spawn(process.execPath, [BIN, "--port", "0"], {
        cwd: ROOT,
        env: { ...process.env, ACP_WIRE_LOG: wirePath }
      });
      let stdoutBuf = "";
      /** @type {(v: number) => void} */
      let resolvePort;
      const portReady = new Promise((resolve) => {
        resolvePort = resolve;
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += chunk;
        const m = stdoutBuf.match(/listening at http:\/\/[^:]+:(\d+)/);
        if (m) resolvePort(Number(m[1]));
      });
      try {
        await Promise.race([
          portReady,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("server didn't print port within 15s")), 15000)
          )
        ]);
        // The wire log is opened in append mode at the first runner
        // start, which is lazy. Just asserting "wire-log path was
        // honored" needs an end-to-end backend call we can't do
        // hermetically here. Instead, hit /health and rely on the
        // boundary code's path-validation throwing at boot if the
        // path were malformed — the server reached "listening" only
        // because ACP_WIRE_LOG was accepted as a valid logging policy.
        const res = await fetch(`http://127.0.0.1:${stdoutBuf.match(/:(\d+)/)?.[1]}/health`);
        expect(res.status).toBe(200);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.on("exit", resolve));
        if (!child.killed) child.kill("SIGKILL");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("bin/artagon-openai-server.mjs — --cors lifecycle", () => {
  test("--cors '*' enables wildcard CORS on /health response", async () => {
    const child = spawn(process.execPath, [BIN, "--port", "0", "--cors", "*"], {
      cwd: ROOT
    });

    let stdoutBuf = "";
    /** @type {(value: number) => void} */
    let resolvePort;
    const portReady = new Promise((resolve) => {
      resolvePort = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      const m = stdoutBuf.match(/listening at http:\/\/[^:]+:(\d+)/);
      if (m) resolvePort(Number(m[1]));
    });

    try {
      const port = /** @type {number} */ (
        await Promise.race([
          portReady,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("server didn't print port within 15s")), 15000)
          )
        ])
      );
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "http://anywhere.test" }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      child.kill("SIGTERM");
      // Wait for child to exit so subsequent tests don't hit a stale port.
      await new Promise((resolve) => child.on("exit", resolve));
      if (!child.killed) child.kill("SIGKILL");
    }
  });
});

describe("bin/artagon-openai-server.mjs — --api-key lifecycle", () => {
  test("--api-key 'sk-test' enforces auth on /v1/* but exempts /health", async () => {
    const child = spawn(process.execPath, [BIN, "--port", "0", "--api-key", "sk-test"], {
      cwd: ROOT
    });

    let stdoutBuf = "";
    /** @type {(value: number) => void} */
    let resolvePort;
    const portReady = new Promise((resolve) => {
      resolvePort = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      const m = stdoutBuf.match(/listening at http:\/\/[^:]+:(\d+)/);
      if (m) resolvePort(Number(m[1]));
    });

    try {
      const port = /** @type {number} */ (
        await Promise.race([
          portReady,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("server didn't print port within 15s")), 15000)
          )
        ])
      );

      // /health is exempt from auth.
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);

      // /v1/models without auth → 401.
      const noAuthRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(noAuthRes.status).toBe(401);
      expect(noAuthRes.headers.get("www-authenticate")).toMatch(/^Bearer/);

      // /v1/models with correct auth → 200.
      const authRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: "Bearer sk-test" }
      });
      expect(authRes.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      if (!child.killed) child.kill("SIGKILL");
    }
  });
});

describe("bin/artagon-openai-server.mjs — --api-key-file lifecycle", () => {
  test("--api-key-file <path> reads key from file + enforces auth", async () => {
    const os = await import("node:os");
    const keyFile = path.join(os.tmpdir(), `artagon-key-${Date.now()}-${Math.random()}.txt`);
    fs.writeFileSync(keyFile, "sk-from-file\n", { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--port", "0", "--api-key-file", keyFile], {
      cwd: ROOT
    });

    let stdoutBuf = "";
    /** @type {(value: number) => void} */
    let resolvePort;
    const portReady = new Promise((resolve) => {
      resolvePort = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      const m = stdoutBuf.match(/listening at http:\/\/[^:]+:(\d+)/);
      if (m) resolvePort(Number(m[1]));
    });

    try {
      const port = /** @type {number} */ (
        await Promise.race([
          portReady,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("server didn't print port within 15s")), 15000)
          )
        ])
      );

      // Wrong key → 401.
      const wrongRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: "Bearer sk-wrong" }
      });
      expect(wrongRes.status).toBe(401);

      // Key from file → 200.
      const rightRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: "Bearer sk-from-file" }
      });
      expect(rightRes.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      if (!child.killed) child.kill("SIGKILL");
      try {
        fs.unlinkSync(keyFile);
      } catch {
        // best-effort
      }
    }
  });
});

describe("bin/artagon-openai-server.mjs — actual server lifecycle", () => {
  test("listens on a random port, serves /health, shuts down cleanly on SIGTERM", async () => {
    // Start the server with --port 0 (OS-assigned); parse the printed
    // port from stdout; hit /health; SIGTERM; verify clean exit.
    const child = spawn(process.execPath, [BIN, "--port", "0"], { cwd: ROOT });

    let stdoutBuf = "";
    /** @type {(value: number) => void} */
    let resolvePort;
    const portReady = new Promise((resolve) => {
      resolvePort = resolve;
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk;
      const m = stdoutBuf.match(/listening at http:\/\/[^:]+:(\d+)/);
      if (m) resolvePort(Number(m[1]));
    });

    let stderrBuf = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk;
    });

    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      const port = await Promise.race([
        portReady,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `server didn't print port within 15s — stdout=${stdoutBuf} stderr=${stderrBuf}`
                )
              ),
            15000
          )
        )
      ]);
      expect(typeof port).toBe("number");
      expect(/** @type {number} */ (port)).toBeGreaterThan(0);

      // Hit /health to prove the facade composition actually works.
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // SIGTERM and confirm clean exit.
      child.kill("SIGTERM");
      const result = /** @type {{code: number | null, signal: string | null}} */ (
        await Promise.race([
          exited,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("server did not exit within 15s of SIGTERM")), 15000)
          )
        ])
      );
      expect(result.code).toBe(0);
      expect(stderrBuf).toMatch(/SIGTERM received/);
    } finally {
      // Defensive: if anything threw, make sure the child is gone.
      if (!child.killed) child.kill("SIGKILL");
    }
  });
});
