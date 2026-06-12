/**
 * Skeleton API client. No network behavior yet — filled in by P2-3.
 */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  request(_path: string): Promise<unknown> {
    void this.baseUrl;
    throw new Error("not implemented");
  }
}
