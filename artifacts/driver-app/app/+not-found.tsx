import { Link, Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useT } from "@/lib/i18n";

export default function NotFoundScreen() {
  const { t } = useT();
  return (
    <>
      <Stack.Screen options={{ title: t("notFound.title") }} />
      <View style={styles.container}>
        <Text style={styles.title}>{t("notFound.body")}</Text>

        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>{t("notFound.home")}</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
  linkText: {
    fontSize: 14,
    color: "#2e78b7",
  },
});
