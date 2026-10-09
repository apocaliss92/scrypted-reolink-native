import { describe, expect, it, vi } from "vitest";
import {
  parseTalkModeSetting,
  TALK_MODE_DEFAULT,
  TALK_MODE_FULL_DUPLEX,
  withTalkAudioStreamMode,
} from "../src/intercom";

/**
 * Battery doorbells advertise only `followVideoStream` in TalkAbility. In that
 * mode the doorbell streams exact digital silence for its microphone for as long
 * as the talk session is open, so the visitor cannot be heard while you talk.
 * The same doorbell accepts `mixAudioStream` and keeps the microphone live.
 * nodelink-js always uses the first advertised mode, so the plugin reorders the
 * advertised list for the duration of session setup.
 */

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as Console;

class FakeApi {
  async getTalkAbilityWithClient(_client: unknown, _channel: number) {
    return {
      duplexList: ["FDX"],
      audioStreamModeList: ["followVideoStream"],
      audioConfigList: [],
    };
  }
}

describe("talk mode setting", () => {
  it("maps only the full-duplex choice to mixAudioStream", () => {
    expect(parseTalkModeSetting(TALK_MODE_FULL_DUPLEX)).toBe("mixAudioStream");
    expect(parseTalkModeSetting(TALK_MODE_DEFAULT)).toBeUndefined();
    expect(parseTalkModeSetting(undefined)).toBeUndefined();
    expect(parseTalkModeSetting("garbage")).toBeUndefined();
  });
});

describe("withTalkAudioStreamMode", () => {
  it("puts the requested mode first while the session is being created", async () => {
    const api = new FakeApi() as any;
    const seen = await withTalkAudioStreamMode(api, "mixAudioStream", logger, () =>
      api.getTalkAbilityWithClient({}, 0),
    );
    expect(seen.audioStreamModeList).toEqual([
      "mixAudioStream",
      "followVideoStream",
    ]);
  });

  it("restores the API afterwards, including when session setup throws", async () => {
    const api = new FakeApi() as any;
    await withTalkAudioStreamMode(api, "mixAudioStream", logger, async () => 1);
    expect(Object.prototype.hasOwnProperty.call(api, "getTalkAbilityWithClient")).toBe(false);

    await expect(
      withTalkAudioStreamMode(api, "mixAudioStream", logger, async () => {
        throw new Error("TalkConfig rejected");
      }),
    ).rejects.toThrow("TalkConfig rejected");
    expect(Object.prototype.hasOwnProperty.call(api, "getTalkAbilityWithClient")).toBe(false);
    const after = await api.getTalkAbilityWithClient({}, 0);
    expect(after.audioStreamModeList).toEqual(["followVideoStream"]);
  });

  it("leaves the camera default untouched when no mode is requested", async () => {
    const api = new FakeApi() as any;
    const seen = await withTalkAudioStreamMode(api, undefined, logger, () =>
      api.getTalkAbilityWithClient({}, 0),
    );
    expect(seen.audioStreamModeList).toEqual(["followVideoStream"]);
  });
});
