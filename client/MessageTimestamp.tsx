import { formatMessageTime, type ItemTimestamps } from "./message-time";

export default function MessageTimestamp(props: ItemTimestamps) {
  const time = formatMessageTime(props);
  return time ? (
    <time className="message-timestamp" dateTime={time.dateTime} title={time.title}>{time.label}</time>
  ) : (
    <span className="message-timestamp" title="No timestamp was recorded for this message.">Time unknown</span>
  );
}
