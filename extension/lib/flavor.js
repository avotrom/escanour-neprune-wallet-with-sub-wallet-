// Which build this is. The source tree is the full build; scripts/package.sh
// rewrites this line to 'light' for the package without the node module.
//   'light': no node. The wallet trusts its sync server for chain validity.
//   'node' : can also run as a succinct node (verifies the chain itself).
export const FLAVOR = 'node';
