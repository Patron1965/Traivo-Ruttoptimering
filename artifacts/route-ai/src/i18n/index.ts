import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import sv from "./locales/sv.json";

const savedLang = localStorage.getItem("routeai-lang") || "sv";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sv: { translation: sv },
  },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
  initImmediate: false,
});

document.documentElement.lang = i18n.resolvedLanguage || i18n.language;

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = i18n.resolvedLanguage || lng;
  localStorage.setItem("routeai-lang", lng);
});

export default i18n;
