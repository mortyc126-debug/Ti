import { afterEach, expect, it, vi } from "vitest";

class FakeSocket {
  static lastInstance = null;

  constructor(url) {
    this.url = url;
    this.sentMessages = [];
    FakeSocket.lastInstance = this;
  }

  send(message) {
    this.sentMessages.push(message);
  }

  close() {}
}

function joinChat(url, userName) {
  const socket = new WebSocket(url);
  socket.send(JSON.stringify({ type: "join", userName }));
  return socket;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("при входе в чат отправляется сообщение join", () => {
  vi.stubGlobal("WebSocket", FakeSocket);

  joinChat("wss://chat.example.com", "Мира");

  expect(FakeSocket.lastInstance.url).toBe("wss://chat.example.com");
  expect(FakeSocket.lastInstance.sentMessages).toEqual([
    JSON.stringify({ type: "join", userName: "Мира" }),
  ]);
});
