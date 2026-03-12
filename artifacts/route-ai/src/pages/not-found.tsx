import { AppLayout } from "@/components/layout/AppLayout";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4 max-w-md">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10 mb-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
          <h1 className="text-4xl font-bold text-foreground">{t("notFound.title")}</h1>
          <p className="text-lg text-muted-foreground">
            {t("notFound.message")}
          </p>
          <Link href="/">
            <Button className="mt-4">{t("notFound.backToDashboard")}</Button>
          </Link>
        </div>
      </div>
    </AppLayout>
  );
}
