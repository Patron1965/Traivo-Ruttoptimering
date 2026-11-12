import test from "node:test";
import assert from "node:assert/strict";
import { prepareBrowserPhoto } from "./photo-input.ts";

test("browser photo is decoded, bounded, re-encoded and its object URL released", async () => {
  const originalImage = globalThis.Image;
  const originalDocument = globalThis.document;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  let revoked = 0;
  let fails = false;
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
    toDataURL: (type: string) => {
      assert.equal(type, "image/jpeg");
      return "data:image/jpeg;base64,/9j/2Q==";
    },
  };
  try {
    Object.assign(globalThis, {
      Image: class {
        naturalWidth = 3840; naturalHeight = 2160;
        async decode() { if (fails) throw new Error("unsupported"); }
      },
      document: { createElement: () => canvas },
    });
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => { revoked++; };
    assert.match(await prepareBrowserPhoto({ size: 100 } as File), /^data:image\/jpeg;base64,/);
    assert.equal(canvas.width, 1920);
    assert.equal(canvas.height, 1080);
    assert.equal(revoked, 1);
    fails = true;
    await assert.rejects(prepareBrowserPhoto({ size: 100 } as File));
    assert.equal(revoked, 2);
    await assert.rejects(prepareBrowserPhoto({ size: 21 * 1024 * 1024 } as File));
    assert.equal(revoked, 2);
  } finally {
    Object.assign(globalThis, { Image: originalImage, document: originalDocument });
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});
