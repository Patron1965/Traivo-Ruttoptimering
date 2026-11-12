import AsyncStorage from "@react-native-async-storage/async-storage";
import { connection } from "./connection-config";
import { environmentStore } from "./connection-target";

export default environmentStore(AsyncStorage, connection.storagePrefix);
