// A file imported with ?raw arrives as its text: Vite's own way of pulling in an asset, which keeps the
// client free of filesystem APIs and their type definitions.
declare module '*?raw' {
  const content: string;
  export default content;
}
