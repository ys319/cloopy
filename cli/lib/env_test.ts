import { assertEquals } from "@std/assert";
import { readEnvFile, setEnvVar } from "./env.ts";
import { resolve } from "@std/path";

/** Create a temp dir and return a helper to write/read .env inside it */
function makeTmpProject(): {
  root: string;
  envPath: string;
  cleanup: () => void;
} {
  const root = Deno.makeTempDirSync();
  const envPath = resolve(root, ".env");
  return {
    root,
    envPath,
    cleanup: () => Deno.removeSync(root, { recursive: true }),
  };
}

// --------------------------------------------------------------------------
// readEnvFile
// --------------------------------------------------------------------------

Deno.test("readEnvFile: parses key=value pairs", () => {
  const { root, envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "FOO=bar\nBAZ=123\n");
    const map = readEnvFile(root);
    assertEquals(map.get("FOO"), "bar");
    assertEquals(map.get("BAZ"), "123");
    assertEquals(map.size, 2);
  } finally {
    cleanup();
  }
});

Deno.test("readEnvFile: skips comments and blank lines", () => {
  const { root, envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "# comment\n\nKEY=val\n  \n");
    const map = readEnvFile(root);
    assertEquals(map.size, 1);
    assertEquals(map.get("KEY"), "val");
  } finally {
    cleanup();
  }
});

Deno.test("readEnvFile: handles value containing =", () => {
  const { root, envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "URL=https://host?a=1&b=2\n");
    const map = readEnvFile(root);
    assertEquals(map.get("URL"), "https://host?a=1&b=2");
  } finally {
    cleanup();
  }
});

Deno.test("readEnvFile: returns empty map when .env missing", () => {
  const root = Deno.makeTempDirSync();
  try {
    const map = readEnvFile(root);
    assertEquals(map.size, 0);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("readEnvFile: handles Windows-style line endings", () => {
  const { root, envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "A=1\r\nB=2\r\n");
    const map = readEnvFile(root);
    assertEquals(map.get("A"), "1");
    assertEquals(map.get("B"), "2");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// setEnvVar
// --------------------------------------------------------------------------

Deno.test("setEnvVar: appends new key to existing file", () => {
  const { envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "EXISTING=yes\n");
    setEnvVar(envPath, "NEW_KEY", "hello");
    const content = Deno.readTextFileSync(envPath);
    assertEquals(content.includes("NEW_KEY=hello"), true);
    assertEquals(content.includes("EXISTING=yes"), true);
  } finally {
    cleanup();
  }
});

Deno.test("setEnvVar: updates existing key in-place", () => {
  const { envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "PORT=8080\nHOST=localhost\n");
    setEnvVar(envPath, "PORT", "9090");
    const content = Deno.readTextFileSync(envPath);
    assertEquals(content.includes("PORT=9090"), true);
    assertEquals(content.includes("PORT=8080"), false);
    assertEquals(content.includes("HOST=localhost"), true);
  } finally {
    cleanup();
  }
});

Deno.test("setEnvVar: inserts auto key before END marker", () => {
  const { envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(
      envPath,
      "# BEGIN cloopy auto-managed\n# END cloopy auto-managed\nUSER=val\n",
    );
    setEnvVar(envPath, "AUTO_KEY", "auto_val", true);
    const content = Deno.readTextFileSync(envPath);
    const endIdx = content.indexOf("# END cloopy auto-managed");
    const keyIdx = content.indexOf("AUTO_KEY=auto_val");
    assertEquals(keyIdx < endIdx, true);
  } finally {
    cleanup();
  }
});

Deno.test("setEnvVar: creates file if it does not exist", () => {
  const { envPath, cleanup } = makeTmpProject();
  try {
    // Ensure file does not exist
    try {
      Deno.removeSync(envPath);
    } catch { /* ok */ }
    setEnvVar(envPath, "FRESH", "value");
    const content = Deno.readTextFileSync(envPath);
    assertEquals(content.includes("FRESH=value"), true);
  } finally {
    cleanup();
  }
});

Deno.test("setEnvVar: auto key appends when no END marker", () => {
  const { envPath, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(envPath, "A=1\n");
    setEnvVar(envPath, "B", "2", true);
    const content = Deno.readTextFileSync(envPath);
    assertEquals(content.includes("B=2"), true);
  } finally {
    cleanup();
  }
});
