import { Database, SQLite3Error, QueryOptions, QueryResult, RunResult, Statement } from 'node-sqlite3-wasm';
import DeathEvent from './death-event';

export type AvailableDataTypeType = string | number | boolean | null;

export type WhereConditionItemType = {
    /** The column name */
    key: string;
    /** The comparison operator */
    operator: "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE";
    /** The compared value */
    compared: AvailableDataTypeType;
    /** The logical operator. it will be ignored if its item comes first in the expression */
    logicalOperator: "AND" | "OR";
}

export type Logger = {
    info: (message: string) => void;
    error: (message: string) => void;
};

export type DataTypesSqlType = "NULL" | "INTEGER" | "REAL" | "TEXT" | "BOOLEAN";
export const DataTypeItems = ["NULL", "INTEGER", "REAL", "TEXT", "BOOLEAN"];

export type TableFrameInitType = {
    [key: string]: {
        /** Data type of the column, in SQLite */
        type: DataTypesSqlType;
        /** Whether the column is a primary key */
        primaryKey?: boolean;
        /** Whether the column is not null */
        notNull?: boolean;
        /** The default value of the column */
        defaultValue?: string | number | boolean | null;
        /** Foreign key constraint (referenced table and column) */
        foreignKey?: {
            references: string;
            column: string;
            onDelete?: "CASCADE" | "SET NULL" | "NO ACTION" | "RESTRICT";
            onUpdate?: "CASCADE" | "SET NULL" | "NO ACTION" | "RESTRICT";
        }
    }
}

export type TableFrameDataType = {
    [key: string]: string | number | boolean | null;
}

/** constrain the characters to prevent the injection attack */
const checkSqlQueryIdentifierName = (characters: string) => {
    const allowedChars = /^[a-zA-Z0-9_\s]+$/;
    const singleStar = /\*$/;
    const allowTuple = /^\([a-zA-Z0-9_,\s]+\)$/;
    return allowedChars.test(characters) || singleStar.test(characters) || allowTuple.test(characters);
}

export class DatabaseWrapper {
    readonly db: Database;
    private tables: { [key: string]: TableFrameInitType } = {};
    readonly dbPath: string;
    readonly logger: Logger;
    readonly cacheRecordMaximum: number = 512;
    private cachedStatements: Map<string, Statement> = new Map();
    readonly deathEvent: DeathEvent;

    /**
     * @param dbName The name of the database file, without extension.
     * @param dbDirectory Optional: directory path where the DB file will be saved.
     * @param deathEvent The death event manager
     * @param logger Optional: logger for debugging.
     */
    constructor(dbName: string, dbDirectory: string = "./", deathEvent: DeathEvent, logger: Logger = { info: console.log, error: console.error }) {
        if (!global.process) {
            throw new Error("This method can only be used in Node.js");
        }
        if (!checkSqlQueryIdentifierName(dbName)) throw new Error(`Invalid characters in db name: ${dbName}`);

        this.dbPath = `${dbDirectory}${dbDirectory.endsWith("/") ? "" : "/"}${dbName}.db`;
        this.logger = logger;
        this.deathEvent = deathEvent;

        try {
            this.db = new Database(this.dbPath);
            this.logger.info(`DatabaseWrapper: Prepared database at ${this.dbPath}`);
            this.enableForeignKeys(); // Enable foreign key support
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to prepare database: ${(error as SQLite3Error).message || error}`);
            throw new Error(`Failed to prepare database: ${(error as SQLite3Error).message || error}`);
        }

        this.deathEvent.addJob(this.close.bind(this), `Close DB '${dbName}'`);
    }

    private enableForeignKeys() {
        try {
            this.db.run("PRAGMA foreign_keys = ON;");
            this.logger.info("DatabaseWrapper: Foreign keys are enabled.");
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to enable foreign keys: ${(error as SQLite3Error).message}`);
        }
    }

    async isTableExist(tableName: string) {
        const result = (await this.runQuery<Record<string, number>>(`
            SELECT EXISTS(
                SELECT 1 
                FROM sqlite_master 
                WHERE type='table' AND name= ?
            );
        `, [tableName]))[0];
        return result[Object.keys(result)[0]] === 1;
    }

    /**
     * @param tableName The name of the table.
     * @param frame An object where the keys are the column names and the values are the data types.
     * Creates a new table with the specified columns.
     */
    prepareTable(tableName: string, frame: TableFrameInitType) {
        return new Promise<void>((resolve, reject) => {
            if (!checkSqlQueryIdentifierName(tableName)) reject(`Invalid characters in table name: ${tableName}`);

            const command = `CREATE TABLE IF NOT EXISTS ${tableName} (${Object.keys(frame).map(key => {
                const column = frame[key];
                if (!checkSqlQueryIdentifierName(key)) reject(`Invalid characters in column name: ${key}`);
                return `${key} ${column.type}
                            ${column.notNull ? 'NOT NULL' : ''}
                            ${column.primaryKey ? 'PRIMARY KEY' : ''}
                            ${column.defaultValue !== undefined ? `DEFAULT ${JSON.stringify(column.defaultValue)}` : ''}
                            ${column.foreignKey ? `REFERENCES ${column.foreignKey.references}(${column.foreignKey.column}) ON DELETE ${column.foreignKey.onDelete || 'NO ACTION'} ON UPDATE ${column.foreignKey.onUpdate || 'NO ACTION'}` : ''}`;
            }).map(l => l.split("\n").map(r => r.trim()).filter(r => r).join(" ")).join(', ')})`;

            try { this.db.run(command); }
            catch (error) {
                this.logger.error(`DatabaseWrapper: Failed to prepare table due to: ${(error as SQLite3Error).message || error}`);
                reject(`Failed to prepare table due to: ${(error as SQLite3Error).message || error}`);
            }
            this.tables[tableName] = frame; // Store table schema for later use
            this.logger.info(`DatabaseWrapper: Table "${tableName}" ready`);
            resolve()
        });
    }


    /**
     * Deletes a table from the database.
     * @param tableName The name of the table to delete.
     * @throws If the table does not exist or if there is an error deleting the table.
     */
    deleteTable(tableName: string) {
        return new Promise<void>((resolve, reject) => {
            if (!this.tables[tableName]) reject(`Table ${tableName} does not exist`);
            if (!checkSqlQueryIdentifierName(tableName)) reject(`Invalid characters in table name: ${tableName}`);
            try {
                this.db.run(`DROP TABLE IF EXISTS ${tableName}`);
                delete this.tables[tableName];
                this.logger.info(`DatabaseWrapper: Table "${tableName}" deleted`);
                resolve();
            } catch (error) {
                this.logger.error(`DatabaseWrapper: Failed to delete table: ${(error as SQLite3Error).message || error}`);
                reject(`Failed to delete table: ${(error as SQLite3Error).message || error}`);
            }
        });
    }

    private retrieveCache(query: string): Statement | undefined {
        return this.cachedStatements.get(query);
    }

    private recordCache(query: string, statement: Statement) {
        this.cachedStatements.set(query, statement);
    }

    private freeCache() {
        this.cachedStatements.forEach((statement) => statement.finalize());
        this.cachedStatements.clear();
    }

    private cacheSizeGuard() {
        if (this.cachedStatements.size > this.cacheRecordMaximum) {
            this.freeCache();
        }
    }

    private runCommand(query: string, params: AvailableDataTypeType[] = []) {
        return new Promise<RunResult>((resolve, reject) => {
            try {
                const cached = this.retrieveCache(query);
                if (cached) return resolve(cached.run(params));

                const statement = this.db.prepare(query);
                const result = statement.run(params);

                this.cacheSizeGuard();
                this.recordCache(query, statement);
                // statement.finalize(); // must be added to prevent memory leak
                resolve(result);
            } catch (error) {
                this.logger.error(`DatabaseWrapper: Failed to run query: ${(error as SQLite3Error).message || error}`);
                reject(`SQL error: ${(error as SQLite3Error).message || error}`);
            }
        });
    }

    private runQuery<T extends QueryResult = QueryResult>(query: string, params: AvailableDataTypeType[] = [], options: QueryOptions = {}) {
        return new Promise<T[]>((resolve, reject) => {
            try {
                const cached = this.retrieveCache(query);
                if (cached) return resolve(cached.all(params, options) as T[]);

                const statement = this.db.prepare(query);
                const result = statement.all(params, options);

                this.cacheSizeGuard();
                this.recordCache(query, statement);
                //statement.finalize(); // must be added to prevent memory leak
                resolve(result as T[]);
            } catch (error) {
                this.logger.error(`DatabaseWrapper: Failed to run query: ${(error as SQLite3Error).message || error}`);
                reject(`SQL error: ${(error as SQLite3Error).message || error}`);
            }
        })
    }

    private getConditionStr(conditions: WhereConditionItemType[]) {
        if (conditions.length === 0) return "";
        return ` WHERE ${conditions.map((condition, index) => {
            if (!checkSqlQueryIdentifierName(condition.key)) throw new Error(`Invalid characters in column name: ${condition.key}`);
            return ` ${index >= 1 ? condition.logicalOperator : ""} (${condition.key} ${condition.operator} ?)`;
        }).join("")}`;
    }

    /**
     * Fetches data from the specified table based on the given conditions.
     *
     * @param tableName The name of the table to query from.
     * @param columns The columns to fetch from the table.
     * @param conditions An array of conditions to filter the data by.
     * @param limit The maximum number of rows to fetch.
     * @param offset The number of rows to skip before fetching.
     * @returns An array of objects representing the fetched data.
     * @throws If there is an error fetching the filtered data.
     */
    async select<T extends QueryResult = QueryResult>(tableName: string, columns: string[], conditions: WhereConditionItemType[] = [], limit: number = 0, offset = 0) {
        if (!(await this.isTableExist(tableName))) throw new Error(`Table ${tableName} not found.`);
        return new Promise<T[]>((resolve, reject) => {
            if (!checkSqlQueryIdentifierName(tableName)) reject(`Invalid characters in table name: ${tableName}`);
            columns.forEach(c => {
                if (!checkSqlQueryIdentifierName(c)) reject(`Invalid characters in column name: ${c}`);
            })

            let queryStr = `SELECT ${columns.join(",")} FROM ${tableName}`;
            const param = conditions.map(condition => condition.compared);

            if (conditions.length > 0) queryStr += this.getConditionStr(conditions);
            if (limit > 0) {
                queryStr += ` LIMIT ?`;
                param.push(limit);
            }
            if (offset > 0) {
                queryStr += ` OFFSET ?`;
                param.push(offset);
            }

            this.runQuery<T>(queryStr, param)
                .then(result => resolve(result))
                .catch(error => {
                    const msg = `Failed to fetch filtered data from ${tableName}: ${(error as SQLite3Error).message || error}`;
                    this.logger.error("DatabaseWrapper: " + msg);
                    reject(msg);
                });
        })
    }


    /**
     * Inserts a new row into the table.
     * @param tableName The name of the table to insert into.
     * @param dataFrame An object with the column names as keys and the values to insert as values.
     * @throws If there is an error inserting the data.
     */
    insert(tableName: string, dataFrame: TableFrameDataType[], options: {
        conflict?: {
            action: "ROLLBACK" | "FAIL" | "NOTHING" | "UPDATE" | "IGNORE" | "REPLACE",
            key?: string
        }
    } = {}) {
        if (!this.isTableExist(tableName)) return Promise.reject(`Table ${tableName} does not exist`);
        if (!checkSqlQueryIdentifierName(tableName)) return Promise.reject(`Invalid characters in table name: ${tableName}`);

        const queryStr = `INSERT INTO ${tableName} (${Object.keys(dataFrame[0]).map(key => {
            if (!checkSqlQueryIdentifierName(key)) return Promise.reject(`Invalid characters in column name: ${key}`);
            return key;
        }).join(", ")})`;

        const valuesStr = dataFrame.map(item => {
            return ` VALUES (${(new Array(Object.keys(item).length)).fill("?").join(", ")})`;
        }).join(", ");

        const optionStr = !options.conflict ? "" : ` ON CONFLICT ${options.conflict.key ? `(${options.conflict.key})` : ""} DO ${options.conflict.action}`;
        console.log(queryStr + valuesStr + optionStr)
        try {
            return this.runCommand(queryStr + valuesStr + optionStr, dataFrame.map(item => Object.values(item)).flat());
        } catch (error) {
            const msg = `Database error in table "${tableName}": ${(error as SQLite3Error).message || error}`;
            this.logger.error("DatabaseWrapper: " + msg);
            return Promise.reject(msg);
        }
    }

    /**
     * Updates rows in the specified table where the conditions are met.
     * @param tableName The name of the table to update.
     * @param dataFrame An object representing the column names and the new values to update.
     * @param conditions An array of conditions to determine which rows to update.
     * @throws If there is an error updating the data.
     */
    update(tableName: string, dataFrame: TableFrameDataType, conditions: WhereConditionItemType[]) {
        return new Promise<RunResult>((resolve, reject) => {
            if (!this.tables[tableName]) reject(`Table ${tableName} does not exist`);
            if (!checkSqlQueryIdentifierName(tableName)) reject(`Invalid characters in table name: ${tableName}`);

            const keys = Object.keys(dataFrame);
            const values = Object.values(dataFrame);

            const queryStr = `UPDATE ${tableName} SET ${keys.map(key => {
                if (!checkSqlQueryIdentifierName(key)) reject(`Invalid characters in column name: ${key}`);
                return `${key} = ?`;
            }).join(", ")}` + this.getConditionStr(conditions);

            this.runCommand(queryStr, values.concat(conditions.map(c => c.compared)))
                .then(result => resolve(result))
                .catch(error => {
                    const msg = `Failed to update data in ${tableName}: ${(error as SQLite3Error).message || error}`;
                    this.logger.error("DatabaseWrapper: " + msg);
                    reject(msg);
                });
        });
    }


    /**
     * Deletes rows from the specified table where the conditions are met.
     * 
     * @param tableName The name of the table to delete from.
     * @param conditions An array of conditions to determine which rows to delete.
     * @throws If there is an error deleting the data.
     */
    delete(tableName: string, conditions: WhereConditionItemType[]) {
        return new Promise<RunResult>((resolve, reject) => {
            if (!this.isTableExist(tableName)) reject(`Table ${tableName} does not exist`);
            if (!checkSqlQueryIdentifierName(tableName)) reject(`Invalid characters in table name: ${tableName}`);

            const queryStr = `DELETE FROM ${tableName}` + this.getConditionStr(conditions);

            this.runCommand(queryStr, conditions.map(c => c.compared))
                .then(result => resolve(result))
                .catch(error => {
                    const msg = `Failed to delete data from ${tableName}: ${(error as SQLite3Error).message || error}`;
                    this.logger.error("DatabaseWrapper: " + msg);
                    reject(msg);
                });
        })
    }

    /**
     * Begins a new transaction.
     * 
     * This method will throw an error if a transaction is already in progress.
     * 
     * @throws If there is an error beginning the transaction.
     */
    beginTransaction() {
        try {
            this.db.run("BEGIN TRANSACTION");
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to begin transaction: ${(error as SQLite3Error).message}`);
            throw new Error(`Failed to begin transaction: ${(error as SQLite3Error).message}`);
        }
    }

    /**
     * Commits the current transaction.
     * 
     * This method will throw an error if no transaction is in progress.
     * 
     * @throws If there is an error committing the transaction.
     */
    commitTransaction() {
        try {
            this.db.run("COMMIT");
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to commit transaction: ${(error as SQLite3Error).message}`);
            throw new Error(`Failed to commit transaction: ${(error as SQLite3Error).message}`);
        }
    }

    /**
     * Rolls back the current transaction.
     * 
     * This method will throw an error if no transaction is in progress.
     * 
     * @throws If there is an error rolling back the transaction.
     */
    rollbackTransaction() {
        try {
            this.db.run("ROLLBACK");
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to rollback transaction: ${(error as SQLite3Error).message}`);
            throw new Error(`Failed to rollback transaction: ${(error as SQLite3Error).message}`);
        }
    }

    /**
     * Closes the database.
     * 
     * @throws If there is an error closing the database.
     */
    close() {
        try {
            this.freeCache();
            this.db.close();
            return true
        } catch (error) {
            this.logger.error(`DatabaseWrapper: Failed to close database: ${(error as SQLite3Error).message}`);
            return false;
        }
    }
}

export default DatabaseWrapper;
