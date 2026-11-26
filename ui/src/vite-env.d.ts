/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Port du moteur Trame (8731 par défaut). Sert à brancher l'interface de dev sur un moteur de test. */
  readonly VITE_TRAME_PORT?: string;
}
