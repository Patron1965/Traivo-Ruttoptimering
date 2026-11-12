export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export class JsonLogger {
  private readonly sink: LogSink;

  constructor(sink: LogSink = stdoutSink) {
    this.sink = sink;
  }

  emit(fields: LogFields): void {
    this.sink(JSON.stringify(fields));
  }
}

export const logger = new JsonLogger();