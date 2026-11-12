/** Use the same artifact path when exporting and serving the production web app. */
function getWebBasePath(value = process.env.BASE_PATH) {
  const path = (value || "/driver-app").replace(/^\/+|\/+$/g, "");
  return path ? `/${path}/` : "/";
}
module.exports = { getWebBasePath };
