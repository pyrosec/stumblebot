"use strict";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const debug = require("@xmpp/debug");
const url = require("url");
const { client, xml } = require("@xmpp/client");
const xid = require("@xmpp/id");
const fs = require("fs-extra");
const { Stumblechat } = require('stumblechat-client');

const path = require("path");
const mkdirp = require("mkdirp");

const lodash = require("lodash");

const xmpp = client({
  service: process.env.STUMBLEBOT_XMPP_DOMAIN,
  resource: "stumblechat",
  username: "stumblechat",
  password: process.env.STUMBLEBOT_XMPP_PASSWORD || "password",
});

const send = (msg, to) => {
  xmpp.send(
    xml("message", { to, from: 'stumblechat@' + process.env.STUMBLEBOT_XMPP_DOMAIN, id: xid(), type: "chat" }, xml("body", {}, msg)),
  );
};

const cursors = {};

const splitJid = (jid) => jid.match(/(?:[^@/]+)/g).filter(Boolean);

const deleteNullKeys = (o) => {
  if (typeof o !== "object") return o;
  if (Array.isArray(o)) return o.slice().map((v) => deleteNullKeys(v));
  const result = { ...o };
  Object.keys(result).forEach((v) => {
    if (result[v] === null) delete result[v];
    if (typeof result[v] === "object") result[v] = deleteNullKeys(result[v]);
  });
  return result;
};

const timeout = (n) => new Promise((resolve) => setTimeout(resolve, n));
const POLL_INTERVAL = 500;

const toJid = ({ host, username }) => {
  return username + "@" + host;
};

const stumbleSessions = {};
const users = {};

const associate = (v: any) => {
  users[v.handle] = v.username + (v.nick && ("|" + v.nick) || "");
};

const handleCommand = async (body, to) => {
  const tokens = body.split(/\s/g);
  let stumble = stumbleSessions[to];
  if (tokens[0] === "/set-proxy") {
    stumble.proxyOptions = tokens[1];
  } else if (tokens[0] === "/unset-proxy") {
    delete stumble.proxyOptions;
  } else if (tokens[0] === "/login") {
    stumble = (stumbleSessions[to] = Stumblechat.fromObject({}));
    stumble.proxyOptions = process.env.STUMBLEBOT_PROXY || null;
    await stumble.login({
      username: tokens[1],
      password: tokens[2],
      rememberme: true,
    });
    send("success!", to);
    return;
  }
  else if (tokens[0] === "/join") {
    const stumble = stumbleSessions[to];
    await stumble.chooseRoom({ room: tokens[1] });
    delete stumble.proxyOptions;
    stumble
      .attach({
        handler(v) {
          if (v.stumble === 'sysmsg') send(v.text, to);
          if ((v.stumble === 'msg' || v.stumble === 'pvtmsg') && v.handle) send((users[v.handle] || v.handle) + (v.stumble === 'pvtmsg' ? '::<private>' : '') + ':: ' + v.text, to);
	  if (v.stumble === 'join') associate(v);
	  if (v.stumble === 'joined') v.userlist.forEach((v) => associate(v));
        },
      })
      .catch((err) => console.error(err));
    return;
  } else if (tokens[0] === "/users") {
    send(Object.values(users).join('\n'), to);
  } else if (tokens[0] === "/raw") {
    stumble.send(body.substr(5), to);
  } else if (tokens[0] === "/msg") {
    stumble.send(JSON.stringify({ stumble: 'pvtmsg', handle: Object.entries(users).find(([ k, v ]: any) => v.split('|')[0] === tokens[1])[0], text: body.substr(tokens.slice(0, 2).join(' ').length) }));
  } else if (tokens[0][0] === '/') {
    send('invalid command!', to);
  } else {
    stumble.send(JSON.stringify({ stumble: 'msg', text: body }));
  }
};

export const run = (async () => {
  xmpp.on("online", () => {
    console.log("online!");
    xmpp.send(xml("presence"));
  });
  xmpp.on("stanza", async (stanza) => {
    console.log(stanza);
    console.log(stanza.getChild("body"));
    if (!stanza.is("message")) return;
    if (!stanza.getChild("body")) return;
    const to = stanza.attrs.from;
    let body = stanza.getChild("body").children[0].trim();
    await handleCommand(body, to);
  });
  await xmpp.start();
});
