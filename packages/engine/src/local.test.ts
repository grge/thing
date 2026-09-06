/** The memory backends against the shared contract. */
import {
  MemoryInventory,
  MemoryKeyring,
  MemoryLocators,
  MemoryPetnames,
} from './local.memory.js';
import { localConformanceTests } from './local.conformance.js';

localConformanceTests('memory', {
  keys: async () => new MemoryKeyring(),
  inventory: async () => new MemoryInventory(),
  petnames: async () => new MemoryPetnames(),
  locators: async () => new MemoryLocators(),
});
