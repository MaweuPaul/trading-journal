const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

// cTrader Open API transport: a single persistent TLS socket carrying
// length-prefixed Protocol Buffers messages (a 4-byte big-endian length,
// then a serialized ProtoMessage envelope). Requests and responses are
// matched by clientMsgId, a UUID we generate per call — the protocol
// explicitly supports this so a single connection can have several
// requests in flight (see ProtoMessage.clientMsgId in the official schema).
//
// Deliberately built directly against Spotware's public .proto schemas
// (backend/lib/ctrader-proto/) with the current, patched `protobufjs`
// rather than depending on the unmaintained npm cTrader wrapper packages,
// which pin a protobufjs version with a critical arbitrary-code-execution
// CVE (GHSA-xq3m-2v4x-88gg) and several axios CVEs with no fix available.

const PROTO_DIR = path.join(__dirname, 'ctrader-proto');
const HEARTBEAT_INTERVAL_MS = 25 * 1000; // protocol asks for one within 30s of silence
const REQUEST_TIMEOUT_MS = 15 * 1000;

let protoRootPromise = null;
function loadProtoRoot() {
  if (!protoRootPromise) {
    protoRootPromise = protobuf.load([
      path.join(PROTO_DIR, 'OpenApiCommonModelMessages.proto'),
      path.join(PROTO_DIR, 'OpenApiCommonMessages.proto'),
      path.join(PROTO_DIR, 'OpenApiModelMessages.proto'),
      path.join(PROTO_DIR, 'OpenApiMessages.proto'),
    ]);
  }
  return protoRootPromise;
}

const PAYLOAD_TYPE = {
  ERROR_RES: 50,
  HEARTBEAT_EVENT: 51,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  ERROR_RES_OA: 2142, // ProtoOAErrorRes
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  CASH_FLOW_HISTORY_LIST_REQ: 2143,
  CASH_FLOW_HISTORY_LIST_RES: 2144,
};

const REQUEST_MESSAGE_TYPE = {
  [PAYLOAD_TYPE.APPLICATION_AUTH_REQ]: 'ProtoOAApplicationAuthReq',
  [PAYLOAD_TYPE.ACCOUNT_AUTH_REQ]: 'ProtoOAAccountAuthReq',
  [PAYLOAD_TYPE.SYMBOLS_LIST_REQ]: 'ProtoOASymbolsListReq',
  [PAYLOAD_TYPE.SYMBOL_BY_ID_REQ]: 'ProtoOASymbolByIdReq',
  [PAYLOAD_TYPE.ASSET_LIST_REQ]: 'ProtoOAAssetListReq',
  [PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ]: 'ProtoOAGetAccountListByAccessTokenReq',
  [PAYLOAD_TYPE.GET_TRENDBARS_REQ]: 'ProtoOAGetTrendbarsReq',
  [PAYLOAD_TYPE.TRADER_REQ]: 'ProtoOATraderReq',
  [PAYLOAD_TYPE.DEAL_LIST_REQ]: 'ProtoOADealListReq',
  [PAYLOAD_TYPE.CASH_FLOW_HISTORY_LIST_REQ]: 'ProtoOACashFlowHistoryListReq',
};

const RESPONSE_MESSAGE_TYPE = {
  [PAYLOAD_TYPE.APPLICATION_AUTH_RES]: 'ProtoOAApplicationAuthRes',
  [PAYLOAD_TYPE.ACCOUNT_AUTH_RES]: 'ProtoOAAccountAuthRes',
  [PAYLOAD_TYPE.SYMBOLS_LIST_RES]: 'ProtoOASymbolsListRes',
  [PAYLOAD_TYPE.SYMBOL_BY_ID_RES]: 'ProtoOASymbolByIdRes',
  [PAYLOAD_TYPE.ASSET_LIST_RES]: 'ProtoOAAssetListRes',
  [PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES]: 'ProtoOAGetAccountListByAccessTokenRes',
  [PAYLOAD_TYPE.GET_TRENDBARS_RES]: 'ProtoOAGetTrendbarsRes',
  [PAYLOAD_TYPE.ERROR_RES]: 'ProtoErrorRes',
  [PAYLOAD_TYPE.ERROR_RES_OA]: 'ProtoOAErrorRes',
  [PAYLOAD_TYPE.TRADER_RES]: 'ProtoOATraderRes',
  [PAYLOAD_TYPE.DEAL_LIST_RES]: 'ProtoOADealListRes',
  [PAYLOAD_TYPE.CASH_FLOW_HISTORY_LIST_RES]: 'ProtoOACashFlowHistoryListRes',
};

class CTraderApiError extends Error {
  constructor(errorCode, description) {
    super(description || errorCode || 'cTrader Open API error');
    this.name = 'CTraderApiError';
    this.errorCode = errorCode;
  }
}

class CTraderClient {
  constructor({ host, port = 5035 }) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.root = null;
    this.readBuffer = Buffer.alloc(0);
    this.pending = new Map(); // clientMsgId -> { resolve, reject, timeout, expectedPayloadTypes }
    this.heartbeatTimer = null;
    this.connectPromise = null;
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      this.root = await loadProtoRoot();
      await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: this.host, port: this.port, minVersion: 'TLSv1.2' }, () => {
          socket.removeListener('error', onInitialError);
          resolve();
        });
        const onInitialError = err => reject(err);
        socket.once('error', onInitialError);
        socket.on('data', chunk => this._onData(chunk));
        socket.on('error', err => this._onSocketError(err));
        socket.on('close', () => this._onSocketClose());
        this.socket = socket;
      });
      this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    })();
    return this.connectPromise;
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connectPromise = null;
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error('cTrader connection closed'));
    }
    this.pending.clear();
  }

  _onSocketError(err) {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(err);
    }
    this.pending.clear();
  }

  _onSocketClose() {
    this.connectPromise = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _sendHeartbeat() {
    if (!this.socket || !this.root) return;
    try {
      const ProtoMessage = this.root.lookupType('ProtoMessage');
      const frame = ProtoMessage.encode(ProtoMessage.create({ payloadType: PAYLOAD_TYPE.HEARTBEAT_EVENT })).finish();
      this._writeFrame(frame);
    } catch (_e) { /* best-effort keepalive */ }
  }

  _writeFrame(payloadBuffer) {
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(payloadBuffer.length, 0);
    this.socket.write(Buffer.concat([lengthPrefix, payloadBuffer]));
  }

  _onData(chunk) {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 4) {
      const frameLength = this.readBuffer.readUInt32BE(0);
      if (this.readBuffer.length < 4 + frameLength) break; // wait for the rest of the frame
      const frame = this.readBuffer.subarray(4, 4 + frameLength);
      this.readBuffer = this.readBuffer.subarray(4 + frameLength);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const ProtoMessage = this.root.lookupType('ProtoMessage');
    let envelope;
    try {
      envelope = ProtoMessage.decode(frame);
    } catch (err) {
      return; // malformed frame; nothing sensible to do but drop it
    }
    if (envelope.payloadType === PAYLOAD_TYPE.HEARTBEAT_EVENT) return;

    const waiter = envelope.clientMsgId && this.pending.get(envelope.clientMsgId);
    if (!waiter) return; // unsolicited event we don't need (spot subscriptions, etc.)
    clearTimeout(waiter.timeout);
    this.pending.delete(envelope.clientMsgId);

    if (envelope.payloadType === PAYLOAD_TYPE.ERROR_RES || envelope.payloadType === PAYLOAD_TYPE.ERROR_RES_OA) {
      const ErrorType = this.root.lookupType(RESPONSE_MESSAGE_TYPE[envelope.payloadType]);
      const decoded = ErrorType.decode(envelope.payload);
      waiter.reject(new CTraderApiError(decoded.errorCode, decoded.description));
      return;
    }

    const responseTypeName = RESPONSE_MESSAGE_TYPE[envelope.payloadType];
    if (!responseTypeName) {
      waiter.reject(new Error(`Unexpected cTrader response payloadType ${envelope.payloadType}`));
      return;
    }
    const ResponseType = this.root.lookupType(responseTypeName);
    waiter.resolve(ResponseType.decode(envelope.payload));
  }

  async request(requestPayloadType, requestFields) {
    if (!this.socket || !this.root) throw new Error('cTrader client is not connected');
    const requestTypeName = REQUEST_MESSAGE_TYPE[requestPayloadType];
    if (!requestTypeName) throw new Error(`Unknown cTrader request payloadType ${requestPayloadType}`);

    const RequestType = this.root.lookupType(requestTypeName);
    const ProtoMessage = this.root.lookupType('ProtoMessage');
    const clientMsgId = crypto.randomUUID();
    const payload = RequestType.encode(RequestType.create(requestFields)).finish();
    const frame = ProtoMessage.encode(ProtoMessage.create({ payloadType: requestPayloadType, payload, clientMsgId })).finish();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error('cTrader request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientMsgId, { resolve, reject, timeout });
      try {
        this._writeFrame(frame);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(clientMsgId);
        reject(err);
      }
    });
  }
}

module.exports = { CTraderClient, CTraderApiError, PAYLOAD_TYPE, loadProtoRoot };
