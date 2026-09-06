import test from "node:test";
import assert from "node:assert/strict";
import { dictionaries } from "../src/ui/i18n";
import errors from "../src/shared/error-codes.json";

test("all three languages include every interface and error message", () => {
  assert.deepEqual(Object.keys(dictionaries), ["zh-CN", "zh-TW", "en-GB"]);
  const keys = Object.keys(dictionaries["zh-CN"]).sort();
  for (const locale of Object.keys(dictionaries) as Array<keyof typeof dictionaries>) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), keys);
    for (const value of Object.values(dictionaries[locale])) assert.ok(value.trim());
    for (const error of errors) assert.ok(error[locale].trim(), `${locale}: ${error.code}`);
  }
  assert.equal(dictionaries["zh-TW"].settings, "設定");
  assert.equal(dictionaries["zh-TW"].chooseFiles, "選擇檔案");
});
