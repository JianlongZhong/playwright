/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { assert } from '../helper';
import * as platform from '../platform';
import { ConnectionTransport } from '../transport';
import { Protocol } from './protocol';

const debugProtocol = platform.debug('playwright:protocol');
const debugWrappedMessage = platform.debug('wrapped');

// WKBrowserServer uses this special id to issue Browser.close command which we
// should ignore.
export const kBrowserCloseMessageId = -9999;

// We emulate kPageProxyMessageReceived message to unify it with Browser.pageProxyCreated
// and Browser.pageProxyDestroyed for easier management.
export const kPageProxyMessageReceived = 'kPageProxyMessageReceived';
export type PageProxyMessageReceivedPayload = { pageProxyId: string, message: any };

export class WKConnection {
  private _lastId = 0;
  private readonly _transport: ConnectionTransport;
  private _closed = false;
  private _onDisconnect: () => void;

  readonly browserSession: WKSession;

  constructor(transport: ConnectionTransport, onDisconnect: () => void) {
    this._transport = transport;
    this._transport.onmessage = this._dispatchMessage.bind(this);
    this._transport.onclose = this._onClose.bind(this);
    this._onDisconnect = onDisconnect;
    this.browserSession = new WKSession(this, '', 'Browser has been closed.', (message: any) => {
      this.rawSend(message);
    });
  }

  nextMessageId(): number {
    return ++this._lastId;
  }

  rawSend(message: any) {
    message = JSON.stringify(message);
    debugProtocol('SEND ► ' + message);
    this._transport.send(message);
  }

  private _dispatchMessage(message: string) {
    debugProtocol('◀ RECV ' + message);
    const object = JSON.parse(message);
    if (object.id === kBrowserCloseMessageId)
      return;
    if (object.pageProxyId) {
      const payload: PageProxyMessageReceivedPayload = { message: object, pageProxyId: object.pageProxyId };
      this.browserSession.dispatchMessage({ method: kPageProxyMessageReceived, params: payload });
      return;
    }
    this.browserSession.dispatchMessage(object);
  }

  _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._transport.onmessage = null;
    this._transport.onclose = null;
    this.browserSession.dispose();
    this._onDisconnect();
  }

  dispose() {
    this._onClose();
    this._transport.close();
  }
}

export class WKSession extends platform.EventEmitter {
  connection?: WKConnection;
  errorText: string;
  readonly sessionId: string;

  private readonly _rawSend: (message: any) => void;
  private readonly _callbacks = new Map<number, {resolve:(o: any) => void, reject: (e: Error) => void, error: Error, method: string}>();

  on: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  addListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  off: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  removeListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  once: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;

  constructor(connection: WKConnection, sessionId: string, errorText: string, rawSend: (message: any) => void) {
    super();
    this.connection = connection;
    this.sessionId = sessionId;
    this._rawSend = rawSend;
    this.errorText = errorText;
  }

  send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    if (!this.connection)
      return Promise.reject(new Error(`Protocol error (${method}): ${this.errorText}`));
    const id = this.connection.nextMessageId();
    const messageObj = { id, method, params };
    debugWrappedMessage('SEND ► ' + JSON.stringify(messageObj, null, 2));
    const result = new Promise<Protocol.CommandReturnValues[T]>((resolve, reject) => {
      this._callbacks.set(id, {resolve, reject, error: new Error(), method});
    });
    this._rawSend(messageObj);
    return result;
  }

  isDisposed(): boolean {
    return !this.connection;
  }

  dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(rewriteError(callback.error, `Protocol error (${callback.method}): ${this.errorText}`));
    this._callbacks.clear();
    this.connection = undefined;
  }

  dispatchMessage(object: any) {
    debugWrappedMessage('◀ RECV ' + JSON.stringify(object, null, 2));
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error)
        callback.reject(createProtocolError(callback.error, callback.method, object));
      else
        callback.resolve(object.result);
    } else if (object.id) {
      // Response might come after session has been disposed and rejected all callbacks.
      assert(this.isDisposed());
    } else {
      Promise.resolve().then(() => this.emit(object.method, object.params));
    }
  }
}

export function createProtocolError(error: Error, method: string, object: { error: { message: string; data: any; }; }): Error {
  let message = `Protocol error (${method}): ${object.error.message}`;
  if ('data' in object.error)
    message += ` ${object.error.data}`;
  return rewriteError(error, message);
}

export function rewriteError(error: Error, message: string): Error {
  error.message = message;
  return error;
}

export function isSwappedOutError(e: Error) {
  return e.message.includes('Target was swapped out.');
}