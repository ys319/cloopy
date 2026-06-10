import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { getComposeFiles } from "./compose.ts";

/** Create a temp project dir with docker-compose.yml */
function makeTmpProject(): { root: string; cleanup: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(resolve(root, "docker-compose.yml"), "");
  return {
    root,
    cleanup: () => Deno.removeSync(root, { recursive: true }),
  };
}

// --------------------------------------------------------------------------
// getComposeFiles
// --------------------------------------------------------------------------

Deno.test("getComposeFiles: returns base file only when no local override", () => {
  const { root, cleanup } = makeTmpProject();
  try {
    const files = getComposeFiles(root, true);
    assertEquals(files, ["-f", resolve(root, "docker-compose.yml")]);
  } finally {
    cleanup();
  }
});

Deno.test("getComposeFiles: includes local override when present", () => {
  const { root, cleanup } = makeTmpProject();
  try {
    Deno.writeTextFileSync(resolve(root, "docker-compose.local.yml"), "");
    const files = getComposeFiles(root, true);
    assertEquals(files, [
      "-f",
      resolve(root, "docker-compose.yml"),
      "-f",
      resolve(root, "docker-compose.local.yml"),
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("getComposeFiles: quiet=true suppresses log", () => {
  const { root, cleanup } = makeTmpProject();
  const logged: unknown[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    Deno.writeTextFileSync(resolve(root, "docker-compose.local.yml"), "");
    const files = getComposeFiles(root, true);
    assertEquals(files.length, 4);
    assertEquals(logged.length, 0);
  } finally {
    console.log = original;
    cleanup();
  }
});

Deno.test("getComposeFiles: quiet=false logs the local override notice", () => {
  const { root, cleanup } = makeTmpProject();
  const logged: unknown[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    Deno.writeTextFileSync(resolve(root, "docker-compose.local.yml"), "");
    getComposeFiles(root);
    assertEquals(logged.length, 1);
  } finally {
    console.log = original;
    cleanup();
  }
});
