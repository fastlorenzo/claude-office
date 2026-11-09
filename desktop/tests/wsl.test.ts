import { describe, expect, test } from "bun:test";

import { decodeDistroList, linuxHookPath, networkingMode, uncPath } from "../src/wsl";

describe("wsl", () => {
  test("decodes UTF-16LE `wsl -l -q` output, skips docker distros", () => {
    const text = "\uFEFFUbuntu-24.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\n";
    expect(decodeDistroList(Buffer.from(text, "utf16le"))).toEqual(["Ubuntu-24.04", "Debian"]);
  });

  test("decodes UTF-8 output too (WSL_UTF8=1) and drops junk", () => {
    expect(decodeDistroList(Buffer.from("Ubuntu\n..\nbad name\nArch\n", "utf8"))).toEqual([
      "Ubuntu",
      "Arch",
    ]);
  });

  test("networkingMode reads the [wsl2] section only", () => {
    expect(networkingMode("[wsl2]\nnetworkingMode=mirrored\n")).toBe("mirrored");
    expect(networkingMode("[wsl2]\nmemory=8GB\n  networkingMode = Mirrored # yes\n")).toBe("mirrored");
    expect(networkingMode("[experimental]\nnetworkingMode=mirrored\n")).toBe("nat");
    expect(networkingMode("[wsl2]\nnetworkingMode=virtioproxy\n")).toBe("other");
    expect(networkingMode("")).toBe("nat");
  });

  test("hook paths inside the distro", () => {
    expect(linuxHookPath("/home/u/", "1.2.3")).toBe(
      "/home/u/.local/share/claude-office/hook/1.2.3/claude-office-hook",
    );
    expect(uncPath("Ubuntu", "/home/u/.local")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\.local");
  });
});
