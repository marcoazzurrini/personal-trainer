/** Read an untrusted test response without claiming to validate its shape.
 * Each test asserts the endpoint-specific fields and failure behavior it needs.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Test responses include deliberately invalid payloads and unrelated endpoint shapes; assertions remain in the tests.
export function testJson(response: Pick<Response, "json">): Promise<any> {
  return response.json();
}
