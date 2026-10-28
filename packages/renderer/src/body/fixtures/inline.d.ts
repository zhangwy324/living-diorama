// Vite imports a file with `?inline` as a data URL; the tests read the fixtures this way.
declare module "*.png?inline" {
  const url: string;
  export default url;
}
