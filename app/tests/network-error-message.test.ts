import { expect, test } from "bun:test";
import { isNetworkFailure } from "@/components/channels/chat-transcript";

test("the browser's dropped-connection wordings are recognised", () => {
  for (const reason of [
    "network error",
    "Network Error",
    "TypeError: network error",
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
  ]) {
    expect(isNetworkFailure(reason)).toBe(true);
  }
});

test("a provider or model failure is not mistaken for a dropped connection", () => {
  expect(isNetworkFailure("Erreur du fournisseur (HTTP 502)")).toBe(false);
  expect(isNetworkFailure("The network error budget was exceeded")).toBe(false);
});
