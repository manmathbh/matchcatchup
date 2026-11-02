import { createHash, randomBytes, randomUUID } from 'node:crypto';

// One shared in-memory watch room: preset reactions, shared polls and the SSE fan-out.
// Nobody can type free text that other viewers see. No database by design:
// restarting the server clears the room.

export const REACTIONS = ['🔥 What a shot!', '😱 Wicket!', '👏 Well bowled', '😬 So tense', '🙌 Come on SAH!', '💪 Come on GAN!', '😂', '🏏'];

const MAX_FEED = 60;
const MAX_POLLS = 300;
const MAX_VOTERS_PER_IP = 5; // lets a family on one Wi-Fi vote, stops one person stuffing a poll

// IPs are kept only as salted hashes, and the salt changes on every restart.
const salt = randomBytes(16);
export const hashIp = (ip) => createHash('sha256').update(salt).update(String(ip)).digest('hex').slice(0, 16);

export class Room {
  constructor() {
    this.clients = new Set();
    this.feed = [];
    this.polls = new Map();
  }

  addClient(res) {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  push(item) {
    this.feed.push(item);
    if (this.feed.length > MAX_FEED) this.feed.shift();
    this.broadcast('room', item);
    return item;
  }

  react(index) {
    return this.push({ id: randomUUID().slice(0, 8), kind: 'reaction', text: REACTIONS[index], at: Date.now() });
  }

  sharePoll(pollId) {
    const poll = this.polls.get(pollId);
    if (!poll?.shareable) return null;
    if (poll.shared) return { alreadyShared: true };
    poll.shared = true;
    return this.push({ id: randomUUID().slice(0, 8), kind: 'poll', poll: this.publicPoll(poll), at: Date.now() });
  }

  createPoll(question, options, { shareable = false } = {}) {
    const poll = { id: randomUUID().slice(0, 8), question, options, shareable, shared: false, votes: new Map(), votersByIp: new Map() };
    this.polls.set(poll.id, poll);
    if (this.polls.size > MAX_POLLS) this.polls.delete(this.polls.keys().next().value);
    return this.publicPoll(poll);
  }

  vote(pollId, option, voterId, ipHash) {
    const poll = this.polls.get(pollId);
    if (!poll || option < 0 || option >= poll.options.length) return { error: 'not_found' };

    const voters = poll.votersByIp.get(ipHash) ?? new Set();
    if (!voters.has(voterId) && voters.size >= MAX_VOTERS_PER_IP) return { error: 'ip_limit' };
    voters.add(voterId);
    poll.votersByIp.set(ipHash, voters);
    poll.votes.set(`${ipHash}:${voterId}`, option); // re-voting changes your vote

    const pub = this.publicPoll(poll);
    if (poll.shared) this.broadcast('poll', pub);
    return { poll: pub };
  }

  publicPoll(poll) {
    const counts = poll.options.map(() => 0);
    for (const v of poll.votes.values()) counts[v]++;
    return { id: poll.id, question: poll.question, options: poll.options, counts, shareable: poll.shareable };
  }
}
