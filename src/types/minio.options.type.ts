export type MinioOptions = {
  /**
   * Fill this property with an accessible public url to minIO server to enable direct access. Note that this makes the service methods to return url with this prefix.
   *
   * @example
   * http://minio.example.com:9000
   */
  directAccessPrefix: string;
};
