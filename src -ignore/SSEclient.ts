// SSEClientTransport.ts

import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EventSource } from "eventsource";

export class SSEClientTransport implements Transport {
  private eventSource: EventSource;
  private postUrl: string;

  // Optional callbacks defined in the Transport interface
  public onmessage?: (message: any) => void;
  public onerror?: (error: Error) => void;
  public onclose?: () => void;

  constructor(sseUrl: string, postUrl: string) {
    this.postUrl = postUrl;
    this.eventSource = new EventSource(sseUrl);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onmessage && this.onmessage(data);
      } catch (e) {
        this.onerror && this.onerror(e as Error);
      }
    };

    this.eventSource.onerror = () => {
      this.onerror && this.onerror(new Error("SSE connection error"));
    };
  }

  async start(): Promise<void> {
    // The EventSource connection is already established in the constructor
    // This method is required by the Transport interface
    return Promise.resolve();
  }

  async send(message: any): Promise<void> {
    try {
      const response = await fetch(this.postUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }
    } catch (error) {
      this.onerror && this.onerror(error as Error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.eventSource.close();
    this.onclose && this.onclose();
  }
}
