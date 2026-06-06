declare namespace google {
  namespace picker {
    const Action: { PICKED: string; CANCEL: string };
    const Feature: { MULTISELECT_ENABLED: string };

    class PickerBuilder {
      addView(view: DocsView): this;
      setOAuthToken(token: string): this;
      setDeveloperKey(key: string): this;
      enableFeature(feature: string): this;
      setCallback(cb: (data: PickerResponse) => void): this;
      build(): Picker;
    }
    class DocsView {
      setIncludeFolders(v: boolean): this;
      setSelectFolderEnabled(v: boolean): this;
    }
    class Picker {
      setVisible(v: boolean): void;
    }
    interface PickerResponse {
      action: string;
      docs?: PickerDoc[];
    }
    interface PickerDoc {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes?: number;
    }
  }

  namespace accounts {
    namespace oauth2 {
      function initTokenClient(cfg: TokenClientConfig): TokenClient;
      interface TokenClientConfig {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
      }
      interface TokenClient {
        requestAccessToken(opts?: { prompt?: string }): void;
      }
      interface TokenResponse {
        access_token?: string;
        error?: string;
      }
    }
  }
}

interface Window {
  gapi: { load(api: string, cb: () => void): void };
}
