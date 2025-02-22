import { get, setAPIKey } from "@toruslabs/http-helpers";
import { BasePostMessageStream, JRPCRequest, ObjectMultiplex, setupMultiplex, Substream } from "@toruslabs/openlogin-jrpc";
import deepmerge from "lodash.merge";

import configuration from "./config";
import { documentReady, handleStream, htmlToElement, runOnLoad } from "./embedUtils";
import TorusInpageProvider from "./inpage-provider";
import generateIntegrity from "./integrity";
import {
  BUTTON_POSITION,
  BUTTON_POSITION_TYPE,
  CERE_PROD_ENVS,
  EMBED_TRANSLATION_ITEM,
  LOGIN_PROVIDER,
  NetworkInterface,
  PAYMENT_PROVIDER_TYPE,
  PaymentParams,
  PopupMode,
  TORUS_BUILD_ENV,
  TorusCtorArgs,
  TorusLoginParams,
  TorusParams,
  TorusPublicKey,
  UnvalidatedJsonRpcRequest,
  UserInfo,
  VerifierArgs,
  WALLET_OPENLOGIN_VERIFIER_MAP,
  WALLET_PATH,
  WhiteLabelParams,
} from "./interfaces";
import log from "./loglevel";
import PopupHandler from "./PopupHandler";
import sendSiteMetadata from "./siteMetadata";
import {
  FEATURES_CONFIRM_WINDOW,
  FEATURES_DEFAULT_WALLET_WINDOW,
  FEATURES_PROVIDER_CHANGE_WINDOW,
  getPreopenInstanceId,
  getTorusUrl,
  getUserLanguage,
  validatePaymentProvider,
} from "./utils";

const defaultVerifiers = {
  [LOGIN_PROVIDER.GOOGLE]: true,
  [LOGIN_PROVIDER.FACEBOOK]: true,
  [LOGIN_PROVIDER.REDDIT]: true,
  [LOGIN_PROVIDER.TWITCH]: true,
  [LOGIN_PROVIDER.DISCORD]: true,
};

const iframeIntegrity = "sha384-hUCVf4/dRFTMtyB6vphvJ0RhfaCQbcanNY5t1ZWC+MuBiRlt0l1ame3BBMhh+qN/";

const expectedCacheControlHeader = "max-age=3600";

const UNSAFE_METHODS = [
  "eth_sendTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "eth_getEncryptionPublicKey",
  "eth_decrypt",
  "ed25519_transfer",
  "ed25519_sign",
  "ed25519_signRaw",
  "eth_transfer",
  "wallet_requestPermissions",
];

class Torus {
  buttonPosition: BUTTON_POSITION_TYPE = BUTTON_POSITION.BOTTOM_LEFT;

  buttonSize: number;

  torusUrl: string;

  torusIframe: HTMLIFrameElement;

  styleLink: HTMLLinkElement;

  isLoggedIn: boolean;

  isInitialized: boolean;

  torusWidgetVisibility: boolean;

  torusAlert: HTMLDivElement;

  apiKey: string;

  modalZIndex: number;

  alertZIndex: number;

  torusAlertContainer: HTMLDivElement;

  isIframeFullScreen: boolean;

  whiteLabel: WhiteLabelParams;

  requestedVerifier: string;

  currentVerifier: string;

  embedTranslations: EMBED_TRANSLATION_ITEM;

  ethereum: TorusInpageProvider;

  provider: TorusInpageProvider;

  communicationMux: ObjectMultiplex;

  isLoginCallback: () => void;

  paymentProviders = configuration.paymentProviders;

  private loginHint = "";

  private loginOptions: TorusLoginParams["loginOptions"] = {};

  private useWalletConnect: boolean;

  private popupMode: PopupMode = "popup";

  constructor({
    buttonPosition = BUTTON_POSITION.BOTTOM_LEFT,
    buttonSize = 56,
    modalZIndex = 99999,
    apiKey = "torus-default",
    popupMode = "popup",
  }: TorusCtorArgs = {}) {
    this.buttonPosition = buttonPosition;
    this.buttonSize = buttonSize;
    this.torusUrl = "";
    this.isLoggedIn = false; // ethereum.enable working
    this.isInitialized = false; // init done
    this.torusWidgetVisibility = true;
    this.requestedVerifier = "";
    this.currentVerifier = "";
    // this.nodeDetailManager = new NodeDetailManager();
    // this.torusJs = new TorusJs({
    //   metadataHost: "https://metadata.tor.us",
    //   allowHost: "https://signer.tor.us/api/allow",
    //   network: "mainnet",
    // });
    this.apiKey = apiKey;
    setAPIKey(apiKey);
    this.modalZIndex = modalZIndex;
    this.alertZIndex = modalZIndex + 1000;
    this.isIframeFullScreen = false;
    this.popupMode = popupMode;
  }

  async init({
    buildEnv = TORUS_BUILD_ENV.CERE,
    enableLogging = false,
    // deprecated: use loginConfig instead
    enabledVerifiers = defaultVerifiers,
    network,
    loginConfig = {},
    showTorusButton = true,
    integrity = {
      check: false,
      hash: iframeIntegrity,
      version: "",
    },
    whiteLabel,
    skipTKey = false,
    useWalletConnect = false,
    mfaLevel = "default",
    context,
    sessionId,
    sessionNamespace,
    popupMode,
    biconomy,
    authMethod,
    mode,
  }: TorusParams = {}): Promise<void> {
    if (this.isInitialized) throw new Error("Already initialized");
    const { torusUrl, logLevel } = await getTorusUrl(buildEnv, integrity);
    log.info(torusUrl, "url loaded");
    this.torusUrl = torusUrl;
    this.whiteLabel = whiteLabel;
    this.useWalletConnect = useWalletConnect;

    log.setDefaultLevel(logLevel);
    if (enableLogging) log.enableAll();
    else log.disableAll();
    this.torusWidgetVisibility = showTorusButton;
    const torusIframeUrl = new URL(torusUrl);
    if (torusIframeUrl.pathname.endsWith("/")) torusIframeUrl.pathname += "popup";
    else torusIframeUrl.pathname += "/popup";

    if (popupMode) {
      this.popupMode = popupMode;
    }

    if (sessionNamespace) {
      torusIframeUrl.searchParams.append("sessionNamespace", sessionNamespace);
    }

    // Iframe code
    this.torusIframe = htmlToElement<HTMLIFrameElement>(
      `<iframe
        id="torusIframe"
        ${useWalletConnect ? 'allow="camera"' : ""}
        class="torusIframe"
        src="${torusIframeUrl.href}"
        style="display: none; position: fixed; top: 0; right: 0; width: 100%;
        height: 100%; border: none; border-radius: 0; z-index: ${this.modalZIndex}"
      ></iframe>`
    );

    this.torusAlertContainer = htmlToElement<HTMLDivElement>('<div id="torusAlertContainer"></div>');
    this.torusAlertContainer.style.display = "none";
    this.torusAlertContainer.style.setProperty("z-index", this.alertZIndex.toString());

    const link = window.document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("type", "text/css");

    const widgetCssUrl = new URL(torusUrl);
    widgetCssUrl.pathname += "css/widget.css";

    link.setAttribute("href", widgetCssUrl.href);
    this.styleLink = link;

    const { defaultLanguage = getUserLanguage(), customTranslations = {} } = this.whiteLabel || {};
    const mergedTranslations = deepmerge(configuration.translations, customTranslations);
    const languageTranslations = mergedTranslations[defaultLanguage] || configuration.translations[getUserLanguage()];
    this.embedTranslations = languageTranslations.embed;

    const handleSetup = async () => {
      await documentReady();
      return new Promise((resolve, reject) => {
        this.torusIframe.onload = async () => {
          // only do this if iframe is not full screen
          this._setupWeb3();
          const initStream = this.communicationMux.getStream("init_stream") as Substream;
          initStream.on("data", (chunk) => {
            const { name, data, error } = chunk;
            if (name === "init_complete" && data.success) {
              // resolve promise
              this.isInitialized = true;
              this._displayIframe(this.isIframeFullScreen);
              resolve(undefined);
            } else if (error) {
              reject(new Error(error));
            }
          });
          initStream.write({
            name: "init_stream",
            data: {
              enabledVerifiers,
              loginConfig,
              whiteLabel: this.whiteLabel,
              buttonPosition: this.buttonPosition,
              buttonSize: this.buttonSize,
              torusWidgetVisibility: this.torusWidgetVisibility,
              apiKey: this.apiKey,
              skipTKey,
              network,
              mfaLevel,
              context,
              biconomy,
              sessionId,
              authMethod,
              mode,
            },
          });
        };
        window.document.head.appendChild(this.styleLink);
        window.document.body.appendChild(this.torusIframe);
        window.document.body.appendChild(this.torusAlertContainer);
      });
    };

    if (CERE_PROD_ENVS.includes(buildEnv) && integrity.check) {
      // hacky solution to check for iframe integrity
      const fetchUrl = `${torusUrl}/popup`;
      const resp = await fetch(fetchUrl, { cache: "reload" });
      if (resp.headers.get("Cache-Control") !== expectedCacheControlHeader) {
        throw new Error(`Unexpected Cache-Control headers, got ${resp.headers.get("Cache-Control")}`);
      }
      const response = await resp.text();
      const calculatedIntegrity = generateIntegrity(
        {
          algorithms: ["sha384"],
        },
        response
      );
      log.info(calculatedIntegrity, "integrity");
      if (calculatedIntegrity === integrity.hash) {
        await handleSetup();
      } else {
        this.clearInit();
        throw new Error("Integrity check failed");
      }
    } else {
      await handleSetup();
    }
    return undefined;
  }

  login({ verifier = "", login_hint: loginHint = "", loginOptions = {} }: TorusLoginParams = {}): Promise<string[]> {
    if (!this.isInitialized) throw new Error("Call init() first");
    this.requestedVerifier = verifier;
    this.loginHint = loginHint;
    this.loginOptions = loginOptions;
    return this.ethereum.enable();
  }

  logout(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isLoggedIn) {
        reject(new Error("User has not logged in yet"));
        return;
      }

      const logOutStream = this.communicationMux.getStream("logout") as Substream;
      logOutStream.write({ name: "logOut" });
      const statusStream = this.communicationMux.getStream("status") as Substream;
      const statusStreamHandler = (status) => {
        if (!status.loggedIn) {
          this.isLoggedIn = false;
          this.currentVerifier = "";
          this.requestedVerifier = "";
          resolve();
        } else reject(new Error("Some Error Occured"));
      };
      handleStream(statusStream, "data", statusStreamHandler);
    });
  }

  async cleanUp(): Promise<void> {
    if (this.isLoggedIn) {
      await this.logout();
    }
    this.clearInit();
  }

  clearInit(): void {
    function isElement(element: unknown) {
      return element instanceof Element || element instanceof HTMLDocument;
    }
    if (isElement(this.styleLink) && window.document.body.contains(this.styleLink)) {
      this.styleLink.remove();
      this.styleLink = undefined;
    }
    if (isElement(this.torusIframe) && window.document.body.contains(this.torusIframe)) {
      this.torusIframe.remove();
      this.torusIframe = undefined;
    }
    if (isElement(this.torusAlertContainer) && window.document.body.contains(this.torusAlertContainer)) {
      this.torusAlert = undefined;
      this.torusAlertContainer.remove();
      this.torusAlertContainer = undefined;
    }
    this.isInitialized = false;
  }

  hideTorusButton(): void {
    this.torusWidgetVisibility = false;
    this._sendWidgetVisibilityStatus(false);
    this._displayIframe();
  }

  showTorusButton(): void {
    this.torusWidgetVisibility = true;
    this._sendWidgetVisibilityStatus(true);
    this._displayIframe();
  }

  setProvider({ host = "mainnet", chainId = null, networkName = "", ...rest }: NetworkInterface): Promise<void> {
    return new Promise((resolve, reject) => {
      const providerChangeStream = this.communicationMux.getStream("provider_change") as Substream;
      const handler = (chunk) => {
        const { err, success } = chunk.data;
        log.info(chunk);
        if (err) {
          reject(err);
        } else if (success) {
          resolve();
        } else reject(new Error("some error occured"));
      };
      handleStream(providerChangeStream, "data", handler);
      const preopenInstanceId = getPreopenInstanceId();
      this._handleWindow(preopenInstanceId, {
        target: "_blank",
        features: FEATURES_PROVIDER_CHANGE_WINDOW,
      });
      providerChangeStream.write({
        name: "show_provider_change",
        data: {
          network: {
            host,
            chainId,
            networkName,
            ...rest,
          },
          preopenInstanceId,
          override: false,
        },
      });
    });
  }

  showWallet(
    path: WALLET_PATH,
    params: Record<string, string> = {},
    options: {
      target?: string;
      onClose?: () => void;
    } = {}
  ): void {
    const showWalletStream = this.communicationMux.getStream("show_wallet") as Substream;
    const finalPath = path ? `/${path}` : "";
    showWalletStream.write({ name: "show_wallet", data: { path: finalPath } });

    const showWalletHandler = (chunk) => {
      if (chunk.name === "show_wallet_instance") {
        // Let the error propogate up (hence, no try catch)
        const { instanceId, target, ...extraParams } = chunk.data;
        const finalUrl = new URL(`${this.torusUrl}/wallet${finalPath}`);

        Object.entries({ ...extraParams, ...params, instanceId }).forEach(([name, value]) => {
          finalUrl.searchParams.append(name, value as string);
        });

        const walletWindow = new PopupHandler({
          target: options.target || target,
          url: finalUrl,
          features: FEATURES_DEFAULT_WALLET_WINDOW,
        });

        walletWindow.open();

        if (options.onClose) {
          walletWindow.once("close", options.onClose);
        }
      }
    };

    handleStream(showWalletStream, "data", showWalletHandler);
  }

  async getPublicAddress({ verifier, verifierId, isExtended = false }: VerifierArgs): Promise<string | TorusPublicKey> {
    if (!configuration.supportedVerifierList.includes(verifier) || !WALLET_OPENLOGIN_VERIFIER_MAP[verifier]) throw new Error("Unsupported verifier");
    const walletVerifier = verifier;
    const openloginVerifier = WALLET_OPENLOGIN_VERIFIER_MAP[verifier];
    const url = new URL(`https://api.tor.us/lookup/torus`);
    url.searchParams.append("verifier", openloginVerifier);
    url.searchParams.append("verifierId", verifierId);
    url.searchParams.append("walletVerifier", walletVerifier);
    url.searchParams.append("network", "mainnet");
    url.searchParams.append("isExtended", isExtended.toString());
    return get(
      url.href,
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      },
      { useAPIKey: true }
    );
  }

  getUserInfo(message: string): Promise<UserInfo> {
    return new Promise((resolve, reject) => {
      if (this.isLoggedIn) {
        const userInfoAccessStream = this.communicationMux.getStream("user_info_access") as Substream;
        userInfoAccessStream.write({ name: "user_info_access_request" });
        const userInfoAccessHandler = (chunk) => {
          const {
            name,
            data: { approved, payload, rejected, newRequest },
          } = chunk;
          if (name === "user_info_access_response") {
            if (approved) {
              resolve(payload);
            } else if (rejected) {
              reject(new Error("User rejected the request"));
            } else if (newRequest) {
              const userInfoStream = this.communicationMux.getStream("user_info") as Substream;
              const userInfoHandler = (handlerChunk) => {
                if (handlerChunk.name === "user_info_response") {
                  if (handlerChunk.data.approved) {
                    resolve(handlerChunk.data.payload);
                  } else {
                    reject(new Error("User rejected the request"));
                  }
                }
              };
              handleStream(userInfoStream, "data", userInfoHandler);
              const preopenInstanceId = getPreopenInstanceId();
              this._handleWindow(preopenInstanceId, {
                target: "_blank",
                features: FEATURES_PROVIDER_CHANGE_WINDOW,
              });
              userInfoStream.write({ name: "user_info_request", data: { message, preopenInstanceId } });
            }
          }
        };
        handleStream(userInfoAccessStream, "data", userInfoAccessHandler);
      } else reject(new Error("User has not logged in yet"));
    });
  }

  initiateTopup(provider: PAYMENT_PROVIDER_TYPE, params: PaymentParams): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.isInitialized) {
        const { errors, isValid } = validatePaymentProvider(provider, params);
        if (!isValid) {
          reject(new Error(JSON.stringify(errors)));
          return;
        }
        const topupStream = this.communicationMux.getStream("topup") as Substream;
        const topupHandler = (chunk) => {
          if (chunk.name === "topup_response") {
            if (chunk.data.success) {
              resolve(chunk.data.success);
            } else {
              reject(new Error(chunk.data.error));
            }
          }
        };
        handleStream(topupStream, "data", topupHandler);
        const preopenInstanceId = getPreopenInstanceId();
        this._handleWindow(preopenInstanceId);
        topupStream.write({ name: "topup_request", data: { provider, params, preopenInstanceId } });
      } else reject(new Error("Torus is not initialized yet"));
    });
  }

  async loginWithPrivateKey(loginParams: { privateKey: string; userInfo: Omit<UserInfo, "isNewUser"> }): Promise<void> {
    const { privateKey, userInfo } = loginParams;
    return new Promise((resolve, reject) => {
      if (this.isInitialized) {
        if (Buffer.from(privateKey, "hex").length !== 32) {
          reject(new Error("Invalid private key, Please provide a 32 byte valid secp25k1 private key"));
          return;
        }
        const loginPrivKeyStream = this.communicationMux.getStream("login_with_private_key") as Substream;
        const loginHandler = (chunk) => {
          if (chunk.name === "login_with_private_key_response") {
            if (chunk.data.success) {
              resolve(chunk.data.success);
            } else {
              reject(new Error(chunk.data.error));
            }
          }
        };
        handleStream(loginPrivKeyStream, "data", loginHandler);
        loginPrivKeyStream.write({ name: "login_with_private_key_request", data: { privateKey, userInfo } });
      } else reject(new Error("Torus is not initialized yet"));
    });
  }

  async showWalletConnectScanner(): Promise<void> {
    if (!this.useWalletConnect) throw new Error("Set `useWalletConnect` as true in init function options to use wallet connect scanner");
    return new Promise((resolve, reject) => {
      if (this.isLoggedIn) {
        const walletConnectStream = this.communicationMux.getStream("wallet_connect_stream") as Substream;
        const walletConnectHandler = (chunk) => {
          if (chunk.name === "wallet_connect_stream_res") {
            if (chunk.data.success) {
              resolve(chunk.data.success);
            } else {
              reject(new Error(chunk.data.error));
            }
            this._displayIframe();
          }
        };
        handleStream(walletConnectStream, "data", walletConnectHandler);
        walletConnectStream.write({ name: "wallet_connect_stream_req" });
        this._displayIframe(true);
      } else reject(new Error("User has not logged in yet"));
    });
  }

  protected _handleWindow(
    preopenInstanceId: string,
    {
      url,
      target,
      features,
      popupMode = "popup",
    }: {
      url?: string;
      target?: string;
      features?: string;
      popupMode?: PopupMode;
    } = {}
  ): void {
    if (!preopenInstanceId) {
      return;
    }

    const windowStream = this.communicationMux.getStream("window") as Substream;

    if (popupMode === "popup") {
      const finalUrl = new URL(url || `${this.torusUrl}/redirect?preopenInstanceId=${preopenInstanceId}`);

      const handledWindow = new PopupHandler({ url: finalUrl, target, features });

      handledWindow.open();

      if (!handledWindow.window) {
        this._createPopupBlockAlert(preopenInstanceId, finalUrl.href);

        return;
      }

      const closeHandler = ({ preopenInstanceId: receivedId, close }) => {
        if (receivedId === preopenInstanceId && close) {
          handledWindow.close();
          windowStream.removeListener("data", closeHandler);
        }
      };

      windowStream.on("data", closeHandler);

      handledWindow.once("close", () => {
        windowStream.write({
          data: {
            preopenInstanceId,
            closed: true,
          },
        });

        windowStream.removeListener("data", closeHandler);
      });
    }

    windowStream.write({
      name: "opened_window",
      data: {
        popupMode,
        preopenInstanceId,
      },
    });
  }

  protected _setEmbedWhiteLabel(element: HTMLElement): void {
    // Set whitelabel
    const { theme } = this.whiteLabel || {};
    if (theme) {
      const { isDark = false, colors = {} } = theme;
      if (isDark) element.classList.add("torus-dark");

      if (colors.torusBrand1) element.style.setProperty("--torus-brand-1", colors.torusBrand1);
      if (colors.torusGray2) element.style.setProperty("--torus-gray-2", colors.torusGray2);
    }
  }

  protected _getLogoUrl(): string {
    let logoUrl = `${this.torusUrl}/images/logo.svg`;
    if (this.whiteLabel?.theme?.isDark) {
      logoUrl = this.whiteLabel?.logoLight || logoUrl;
    } else {
      logoUrl = this.whiteLabel?.logoDark || logoUrl;
    }

    return logoUrl;
  }

  protected _sendWidgetVisibilityStatus(status: boolean): void {
    const torusWidgetVisibilityStream = this.communicationMux.getStream("torus-widget-visibility") as Substream;
    torusWidgetVisibilityStream.write({
      data: status,
    });
  }

  protected _displayIframe(isFull = false): void {
    const style: Partial<CSSStyleDeclaration> = {};
    const size = this.buttonSize + 14; // 15px padding
    // set phase
    if (!isFull) {
      style.display = this.torusWidgetVisibility ? "block" : "none";
      style.height = `${size}px`;
      style.width = `${size}px`;
      switch (this.buttonPosition) {
        case BUTTON_POSITION.TOP_LEFT:
          style.top = "0px";
          style.left = "0px";
          style.right = "auto";
          style.bottom = "auto";
          break;
        case BUTTON_POSITION.TOP_RIGHT:
          style.top = "0px";
          style.right = "0px";
          style.left = "auto";
          style.bottom = "auto";
          break;
        case BUTTON_POSITION.BOTTOM_RIGHT:
          style.bottom = "0px";
          style.right = "0px";
          style.top = "auto";
          style.left = "auto";
          break;
        case BUTTON_POSITION.BOTTOM_LEFT:
        default:
          style.bottom = "0px";
          style.left = "0px";
          style.top = "auto";
          style.right = "auto";
          break;
      }

      try {
        window.focus();
      } catch {}
    } else {
      style.display = "block";
      style.width = "100%";
      style.height = "100%";
      style.top = "0px";
      style.right = "0px";
      style.left = "0px";
      style.bottom = "0px";

      try {
        this.torusIframe.contentWindow.focus();
      } catch {}
    }
    Object.assign(this.torusIframe.style, style);
    this.isIframeFullScreen = isFull;
  }

  protected _setupWeb3(): void {
    log.info("setupWeb3 running");
    // setup background connection
    const metamaskStream = new BasePostMessageStream({
      name: "embed_metamask",
      target: "iframe_metamask",
      targetWindow: this.torusIframe.contentWindow,
      targetOrigin: new URL(this.torusUrl).origin,
    });

    // Due to compatibility reasons, we should not set up multiplexing on window.metamaskstream
    // because the MetamaskInpageProvider also attempts to do so.
    // We create another LocalMessageDuplexStream for communication between dapp <> iframe
    const communicationStream = new BasePostMessageStream({
      name: "embed_comm",
      target: "iframe_comm",
      targetWindow: this.torusIframe.contentWindow,
      targetOrigin: new URL(this.torusUrl).origin,
    });

    // Backward compatibility with Gotchi :)
    // window.metamaskStream = this.communicationStream

    // compose the inpage provider
    const inpageProvider = new TorusInpageProvider(metamaskStream);

    // detect eth_requestAccounts and pipe to enable for now
    const detectAccountRequestPrototypeModifier = (m) => {
      const originalMethod = inpageProvider[m];
      inpageProvider[m] = function providerFunc(method, ...args) {
        if (method && method === "eth_requestAccounts") {
          return inpageProvider.enable();
        }
        return originalMethod.apply(this, [method, ...args]);
      };
    };

    detectAccountRequestPrototypeModifier("send");
    detectAccountRequestPrototypeModifier("sendAsync");

    inpageProvider.enable = () => {
      return new Promise((resolve, reject) => {
        // If user is already logged in, we assume they have given access to the website
        inpageProvider.sendAsync({ jsonrpc: "2.0", id: getPreopenInstanceId(), method: "eth_requestAccounts", params: [] }, (err, response) => {
          const { result: res } = (response as { result: unknown }) || {};
          if (err) {
            setTimeout(() => {
              reject(err);
            }, 50);
          } else if (Array.isArray(res) && res.length > 0) {
            // If user is already rehydrated, resolve this
            // else wait for something to be written to status stream
            const handleLoginCb = () => {
              if (this.requestedVerifier !== "" && this.currentVerifier !== this.requestedVerifier) {
                const { requestedVerifier } = this;
                // eslint-disable-next-line promise/no-promise-in-callback
                this.logout()
                  // eslint-disable-next-line promise/always-return
                  .then((_) => {
                    this.requestedVerifier = requestedVerifier;
                    this._showLoginPopup(true, resolve, reject);
                  })
                  .catch((error) => reject(error));
              } else {
                resolve(res);
              }
            };
            if (this.isLoggedIn) {
              handleLoginCb();
            } else {
              this.isLoginCallback = handleLoginCb;
            }
          } else {
            // set up listener for login
            this._showLoginPopup(true, resolve, reject);
          }
        });
      });
    };

    inpageProvider.tryPreopenHandle = (payload: UnvalidatedJsonRpcRequest | UnvalidatedJsonRpcRequest[], cb: (...args: unknown[]) => void) => {
      const _payload = payload;
      if (!Array.isArray(_payload) && UNSAFE_METHODS.includes(_payload.method)) {
        const preopenInstanceId = getPreopenInstanceId();
        this._handleWindow(preopenInstanceId, {
          target: "_blank",
          popupMode: this.popupMode, // Transaction popups should support `popupMode` option
          features: FEATURES_CONFIRM_WINDOW,
        });
        _payload.preopenInstanceId = preopenInstanceId;
      }
      inpageProvider._rpcEngine.handle(_payload as JRPCRequest<unknown>[], cb);
    };

    // Work around for web3@1.0 deleting the bound `sendAsync` but not the unbound
    // `sendAsync` method on the prototype, causing `this` reference issues with drizzle
    const proxiedInpageProvider = new Proxy(inpageProvider, {
      // straight up lie that we deleted the property so that it doesnt
      // throw an error in strict mode
      deleteProperty: () => true,
    });

    this.ethereum = proxiedInpageProvider;
    const communicationMux = setupMultiplex(communicationStream);

    this.communicationMux = communicationMux;

    const windowStream = communicationMux.getStream("window") as Substream;
    windowStream.on("data", (chunk) => {
      if (chunk.name === "create_window") {
        this._handleWindow(chunk.data.preopenInstanceId, {
          url: chunk.data.url,
          target: "_blank",
          popupMode: chunk.popupMode || "popup",
          features: FEATURES_DEFAULT_WALLET_WINDOW,
        });
      }

      if (chunk.name === "redirect") {
        window.location.href = chunk.data.url;
      }
    });

    // show torus widget if button clicked
    const widgetStream = communicationMux.getStream("widget") as Substream;
    widgetStream.on("data", (chunk) => {
      const { data } = chunk;
      this._displayIframe(data);
    });

    // Show torus button if wallet has been hydrated/detected
    const statusStream = communicationMux.getStream("status") as Substream;
    statusStream.on("data", (status) => {
      // login
      if (status.loggedIn) {
        this.isLoggedIn = status.loggedIn;
        this.currentVerifier = status.verifier;
      } // logout
      else {
        this.isLoggedIn = false;
        this.currentVerifier = "";
        this.requestedVerifier = "";

        this._sendWidgetVisibilityStatus(false);
        this._displayIframe();
      }

      if (this.isLoginCallback) {
        this.isLoginCallback();
        delete this.isLoginCallback;
      }
    });

    this.provider = proxiedInpageProvider;

    if (this.provider.shouldSendMetadata) sendSiteMetadata(this.provider._rpcEngine);
    inpageProvider._initializeState();
    log.debug("Torus - injected provider");
  }

  protected _showLoginPopup(calledFromEmbed: boolean, resolve: (a: string[]) => void, reject: (err: Error) => void): void {
    const loginHandler = (data) => {
      const { err, selectedAddress } = data;
      if (err) {
        log.warn(err);
        if (reject) reject(err);
      }
      // returns an array (cause accounts expects it)
      else if (resolve) resolve([selectedAddress]);
      if (this.isIframeFullScreen) this._displayIframe();
    };
    const oauthStream = this.communicationMux.getStream("oauth") as Substream;
    if (!this.requestedVerifier) {
      this._displayIframe(true);
      handleStream(oauthStream, "data", loginHandler);
      oauthStream.write({ name: "oauth_modal", data: { calledFromEmbed } });
    } else {
      handleStream(oauthStream, "data", loginHandler);
      let preopenInstanceId: string | undefined;

      if (this.loginOptions.uxMode !== "redirect") {
        preopenInstanceId = getPreopenInstanceId();

        this._handleWindow(preopenInstanceId, {
          popupMode: this.loginOptions.uxMode,
        });
      }

      oauthStream.write({
        name: "oauth",
        data: {
          calledFromEmbed,
          verifier: this.requestedVerifier,
          preopenInstanceId,
          login_hint: this.loginHint,
          loginOptions: this.loginOptions,
        },
      });
    }
  }

  protected _createPopupBlockAlert(preopenInstanceId: string, url: string): void {
    const logoUrl = this._getLogoUrl();
    const torusAlert = htmlToElement<HTMLDivElement>(
      '<div id="torusAlert" class="torus-alert--v2">' +
        `<div id="torusAlert__logo"><img src="${logoUrl}" /></div>` +
        "<div>" +
        `<h1 id="torusAlert__title">${this.embedTranslations.actionRequired}</h1>` +
        `<p id="torusAlert__desc">${this.embedTranslations.pendingAction}</p>` +
        "</div>" +
        "</div>"
    );

    const successAlert = htmlToElement(`<div><a id="torusAlert__btn">${this.embedTranslations.continue}</a></div>`);
    const btnContainer = htmlToElement('<div id="torusAlert__btn-container"></div>');
    btnContainer.appendChild(successAlert);
    torusAlert.appendChild(btnContainer);
    const bindOnLoad = () => {
      successAlert.addEventListener("click", () => {
        this._handleWindow(preopenInstanceId, {
          url,
          target: "_blank",
          features: FEATURES_CONFIRM_WINDOW,
        });
        torusAlert.remove();

        if (this.torusAlertContainer.children.length === 0) this.torusAlertContainer.style.display = "none";
      });
    };

    this._setEmbedWhiteLabel(torusAlert);

    const attachOnLoad = () => {
      this.torusAlertContainer.style.display = "block";
      this.torusAlertContainer.appendChild(torusAlert);
    };

    runOnLoad(attachOnLoad);
    runOnLoad(bindOnLoad);
  }
}

export default Torus;
