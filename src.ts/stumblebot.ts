"use strict";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const debug = require("@xmpp/debug");
const url = require("url");
const { client, xml } = require("@xmpp/client");
const xid = require("@xmpp/id");
const fs = require("fs-extra");
const { Stumblechat } = require("stumblechat-client");

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
    xml(
      "message",
      {
        to,
        from: "stumblechat@" + process.env.STUMBLEBOT_XMPP_DOMAIN,
        id: xid(),
        type: "chat",
      },
      xml("body", {}, msg),
    ),
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

const associate = (v: any, room: string) => {
  users[v.handle] = v.username + "|" + room + ((v.nick && "|" + v.nick) || "");
};

async function appendLog(v) {
  const directory = path.join(process.env.HOME, ".stumblebot");
  await mkdirp(directory);
  await fs.appendFile(path.join(directory, "messages.log"), v + "\n");
}

async function saveSessions() {
  await fs.writeFile(path.join(process.env.HOME, '.stumblebot', 'sessions.json'), JSON.stringify(Object.entries(stumbleSessions).map(([k, v]: any) => [ k, { ...v.toObject(), proxyOptions: v.proxyOptions }]), null, 2));
};

async function loadSessions() {
  try {
    return Object.fromEntries(JSON.parse(await fs.readFile(path.join(process.env.HOME, '.stumblebot', 'sessions.json'), 'utf8')).map(([k, v]: any) => [ k, Object.assign(Stumblechat.fromObject(v), { proxyOptions: v.proxyOptions }) ]));
  } catch (e) {
    return {};
  }
}

const handleCommand = async (body, _to) => {
  const split = _to.split("/");
  const to =
    split.length > 1 ? split.slice(0, split.length - 1).join("/") : split[0];
  const tokens = body.split(/\s/g);
  let stumble = stumbleSessions[to];
  if (tokens[0] === "/set-proxy") {
    stumble.proxyOptions = tokens[1];
  } else if (tokens[0] === "/unset-proxy") {
    delete stumble.proxyOptions;
  } else if (tokens[0] === "/login") {
    stumble = stumbleSessions[to] = Stumblechat.fromObject({});
    stumble.proxyOptions = process.env.STUMBLEBOT_PROXY || null;
    stumble.rooms = {};
    const response = await stumble.login({
      username: tokens[1],
      password: tokens[2],
      rememberme: true,
    });
    console.log(require('util').inspect(response, { colors: true, depth: 15}));
    send("success!", to);
    await saveSessions();
    return;
  } else if (tokens[0] === "/joinall") {
    const _call = stumble._call;
    stumble._call = async function (...args) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random()*3000)));
      return _call.apply(stumble, args);
    }
      
    for (const { name: room } of await stumble.getRooms()) {
      console.log(room);
      let error = null;
      while (true) {
        try {
          await stumble.chooseRoom({ room });
	} catch (e) {
          error = e;
	  console.error(e);
	  await new Promise((resolve) => setTimeout(resolve, 50000));
	  break;
	}
      }
      if (error) {
        continue;
      }
      await stumble
        .attach({
          handler(v) {
            if (typeof v === "object") {
	      v.room = room;
              v.timestamp = Date.now();
              appendLog(JSON.stringify(v, null, 2)).catch((err) =>
                console.error(err),
              );
	    }
            if (v.stumble === "sysmsg") send(v.text, to);
            if ((v.stumble === "msg" || v.stumble === "pvtmsg") && v.handle)
              send(
                (users[v.handle] || v.handle) +
                  (v.stumble === "pvtmsg" ? "::<private>" : "") +
                  ":: " +
                  v.text,
                to,
              );
            if (v.stumble === "join") associate(v, room);
            if (v.stumble === "joined")
              v.userlist.forEach((v) => associate(v, room));
          },
        })
        .catch((err) => console.error(err));
      stumble.rooms[room] = stumble._ws;
      stumble._call = _call;
      await saveSessions();
      await new Promise((resolve) => setTimeout(resolve, 50000));
    }
  } else if (tokens[0] === "/join") {
    const stumble = stumbleSessions[to];
    const room = tokens[1];
    try {
    await stumble.chooseRoom({ room });
    await stumble
      .attach({
        handler(v) {
          if (typeof v === 'object') {
            appendLog(JSON.stringify({ ...v, room, timestamp: Date.now() }, null, 2)).catch((err) => console.error(err));
	  }
          if (v.stumble === "sysmsg") send(v.text, to);
          if ((v.stumble === "msg" || v.stumble === "pvtmsg") && v.handle)
            send(
              (users[v.handle] || v.handle) +
                (v.stumble === "pvtmsg" ? "::<private>" : "") +
                ":: " +
                v.text,
              to,
            );
          if (v.stumble === "join") associate(v, room);
          if (v.stumble === "joined")
            v.userlist.forEach((v) => associate(v, room));
        },
      })
      .catch((err) => console.error(err));
    stumble.rooms[tokens[1]] = stumble._ws;
    } catch (e) {
      send('error', to);
    }
    return;
  } else if (tokens[0] === "/select") {
    stumble._ws = stumble.rooms[tokens[1]];
    send("selected " + tokens[1], to);
  } else if (tokens[0] === "/users") {
    send(Object.values(users).join("\n"), to);
  } else if (tokens[0] === "/rooms") {
    console.log(stumble);
    send(
      (await stumble.getRooms())
        .map(
          (v) =>
            v.name +
            "|" +
            v.topic +
            "|" +
            v.broadcasting_count +
            "|" +
            v.watching_count,
        )
        .join("\n"),
      to,
    );
  } else if (tokens[0] === "/raw") {
    stumble.send(body.substr(5), to);
  } else if (tokens[0] === "/msg") {
    stumble.send(
      JSON.stringify({
        stumble: "pvtmsg",
        handle: Object.entries(users).find(
          ([k, v]: any) => v.split("|")[0] === tokens[1],
        )[0],
        text: body.substr(tokens.slice(0, 2).join(" ").length),
      }),
    );
  } else if (tokens[0] === "/broadcast") {
    const msg = body.substr(0, "/broadcast ".length);
    const start = stumble._ws;
    for (const room of Object.entries(stumble.rooms)) {
      stumble._ws = room[1];
      stumble.send(JSON.stringify({ stumble: "msg", text: msg }));
    }
    stumble._ws = start;
  } else if (tokens[0][0] === "/") {
    send("invalid command!", to);
  } else {
    stumble.send(JSON.stringify({ stumble: "msg", text: body }));
  }
};

export const run = async () => {
  stumbleSessions = await loadSessions();
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
};
