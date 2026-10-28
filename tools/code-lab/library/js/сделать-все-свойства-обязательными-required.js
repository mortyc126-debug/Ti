/** @typedef {{ host?: string, port?: number }} Options */

/**
 * @param {Options} options
 * @returns {Required<Options>}
 */
function withDefaults(options) {
  return { host: "localhost", port: 3000, ...options };
}

console.log(withDefaults({ port: 8080 }));
