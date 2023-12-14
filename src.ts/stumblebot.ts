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

let stumbleSessions = {};
const users = {};

const associate = (v: any) => {
  users[v.handle] = v.username + '|' + v.room + (v.nick && ("|" + v.nick) || "");
};

const STUMBLEBOT_DIRECTORY = path.join(process.env.HOME, '.stumblebot');
const STUMBLEBOT_DATABASE_FILEPATH = path.join(STUMBLEBOT_DIRECTORY, 'db.json');

const saveDatabase = async () => {
  await mkdirp(path.join(process.env.HOME, '.stumblebot'));
  await fs.writeFile(STUMBLEBOT_DATABASE_FILEPATH, JSON.stringify(Object.entries(stumbleSessions).map(([k, v]) => [ k, v.toObject() ])));
};

const loadDatabase = async () => {
  await mkdirp(path.join(process.env.HOME, '.stumblebot'));
  let db = {};
  try {
    db = Object.fromEntries(JSON.parse(await fs.readFile(STUMBLEBOT_DATABASE_FILEPATH, 'utf8')).map(([k, v]) => [ k, Stumblechat.fromObject(v) ]));
  } catch (e) {}
  stumbleSessions = db;
};

const handleCommand = async (body, _to) => {
  const tokens = body.split(/\s/g);
  const split = _to.split('/');
  const to = split.slice(0, Math.max(1, split.length - 1)).join('/');
  let stumble: any = stumbleSessions[to];
  if (tokens[0] === "/set-proxy") {
    stumble.proxyOptions = tokens[1];
  } else if (tokens[0] === "/unset-proxy") {
    delete stumble.proxyOptions;
  } else if (tokens[0] === "/login") {
    stumble = (stumbleSessions[to] = Stumblechat.fromObject({}));
    stumble.rooms = {};
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
    const room = tokens[1];
    await stumble.chooseRoom({ room });
    delete stumble.proxyOptions;
    await stumble
      .attach({
        handler(v) {
          v.room = room;
          if (v.stumble === 'sysmsg' || v.stumble === 'msg') {
	 
            const cacheKey = v.room + ':' + v.stumble + ':' + v.text;
            if (!await redis.get(cacheKey)) {
              await redis.set(cacheKey, '1', 'EX', '10');
	      await redis.rpush(JSON.stringify(v));
            }
	  }
	  if (v.stumble === 'pvtmsg') {
            v.user = to;
            await redis.rpush(JSON.stringify(v));
	  }
	  if (v.stumble === 'join') associate(v);
	  if (v.stumble === 'joined') v.userlist.forEach((v) => associate(v));
        },
      })
      .catch((err) => console.error(err));
    stumble.rooms[tokens[1]] = stumble._ws;
    return;
  } else if (tokens[0] === "/select") {
    const socket = stumble.rooms[tokens[1]];
    if (!socket) send('room not found ' + tokens[1], to);
    else {
      stumble._ws = stumble.rooms[tokens[1]];
      send('room selected ' + tokens[1], to);
    }
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
  await loadDatabase();
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
  xmpp.start().catch((err) => console.error(err));
  (async () => {
    while (true)  {
      try {
        const _msg = await redis.lpop('stumble-in');
        if (!_msg) await timeout(500);
        const msg = JSON.parse(_msg);
	else {
          const usersMapped = Object.entries(users).filter(([ handle, tag ]) => tag.split('|')[0] === msg.to.split('@')[0]).find(([ handle, tag ]) => Object.keys(stumbleSessions[msg.from.split('@')[0] + '@' + process.env.STUMBLEBOT_XMPP_DOMAIN]).find((room) => tag.split('|')[1] === room));

          const handle = 
            if (i > 1) return r;
	    else if (i === 0) r.room = v;
	    else if (i === 1) r.username 
          stumbleSessions[msg.from, msg.to
	}
      } catch (e) {
        console.error(e);
	await timeout(1000);
      }
  })().catch((err) => console.error(err));

});
